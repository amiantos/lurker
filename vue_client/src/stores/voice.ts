// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Voice/video call session for the web client. The browser IS the WebRTC engine
// here, so this is thin: get a room-scoped token (from /api/voice/token for
// members, or /api/voice/guest-token for a public guest), connect the LiveKit
// room, publish the mic (and optionally camera / screen), and render remote
// tracks. Audio autoplays via a hidden <audio>; video is attached by the tile
// components (see the adaptiveStream note below).
//
// Bundle bloat, addressed: livekit-client is ~500 KB and voice is off by default
// on most instances, so it is pulled in with a dynamic import() inside the
// connect path — Vite splits it into its own chunk fetched only at first call.
//
// The Room and all Track/element handles are held module-scoped, NOT in Pinia
// state: they are non-serializable and must not be wrapped in Vue's reactive
// proxy, which would break livekit's object identity. State carries only the
// primitives the UI renders.
//
// adaptiveStream note: the Room uses adaptiveStream, so a remote *video* track
// only starts flowing once it is attach()ed to a visible <video> element (and
// pauses when hidden). So the store exposes video tracks and the VideoTile
// components own the attach/detach lifecycle — video is NOT attached to a hidden
// element here (audio is, which is correct for audio).

import { defineStore } from 'pinia';
import type {
  Room,
  RemoteTrack,
  RemoteAudioTrack,
  RemoteVideoTrack,
  RemoteParticipant,
  Participant,
  LocalTrackPublication,
  LocalVideoTrack,
} from 'livekit-client';
import { api } from '../api.js';

interface VoiceTokenResponse {
  token: string;
  room: string;
  url: string;
}

export interface VideoTile {
  identity: string;
  source: string; // 'camera' | 'screen_share'
  self: boolean;
}

// Non-reactive session handles (see header note).
let room: Room | null = null;
let audioEls: HTMLAudioElement[] = [];
// identity → remote audio track, for per-participant volume.
let tracksByIdentity = new Map<string, RemoteAudioTrack>();
// `${identity}|${source}` → remote video track, attached by VideoTile.
let videoTracksByKey = new Map<string, RemoteVideoTrack>();
// source ('camera' | 'screen_share') → our own local video track, for self tiles.
let localVideoTracks = new Map<string, LocalVideoTrack>();

export const useVoiceStore = defineStore('voice', {
  state: () => ({
    active: false,
    connecting: false,
    muted: false,
    cameraOn: false,
    screenOn: false,
    // Human label for what's being called, e.g. "#dev".
    label: '',
    // The channel/DM this call belongs to (for moderation + guest-link calls).
    networkId: null as number | null,
    target: '',
    // True when this tab joined via a public guest link (no account/session).
    isGuest: false,
    // Remote participant identities (our IRC-nick convention).
    participants: [] as string[],
    // Subset of `participants` currently detected as speaking.
    speaking: [] as string[],
    // Per-identity local playback volume, 0..1 (default 1 when absent).
    volumes: {} as Record<string, number>,
    // Video/screen tiles to render (self + remote).
    videoTiles: [] as VideoTile[],
    error: null as string | null,
  }),
  actions: {
    // Member join: mint a token for a channel/DM, then connect.
    async startCall(networkId: number, target: string, label: string) {
      if (this.active || this.connecting) return;
      this.connecting = true;
      this.error = null;
      this.label = label;
      this.networkId = networkId;
      this.target = target;
      this.isGuest = false;
      try {
        // Token first, so a 503/403/404 fails fast without paying to load the SDK.
        const { token, url } = await api<VoiceTokenResponse>('/api/voice/token', {
          method: 'POST',
          body: { networkId, target },
        });
        await this.connectWithToken(url, token, label);
      } catch (e: unknown) {
        this.error = e instanceof Error ? e.message : 'could not start call';
        await this.cleanup();
        this.connecting = false;
      }
    },

    // Shared connect path — used by member calls and by the public guest page
    // (which has already exchanged its link token for a room token).
    async connectWithToken(url: string, token: string, label: string, opts?: { guest?: boolean }) {
      if (this.active) return;
      this.connecting = true;
      this.label = label;
      if (opts?.guest) this.isGuest = true;
      try {
        // Lazy chunk: livekit-client only lands over the network at first call.
        const { Room, RoomEvent, Track } = await import('livekit-client');

        const r = new Room({ adaptiveStream: true, dynacast: true });
        r.on(
          RoomEvent.TrackSubscribed,
          (track: RemoteTrack, pub, participant: RemoteParticipant) => {
            if (track.kind === Track.Kind.Audio) {
              const audio = track as RemoteAudioTrack;
              // Attach ALL audio (mic + screen_share_audio) so both play; but only
              // bind the per-participant volume slider to the mic track.
              const el = audio.attach() as HTMLAudioElement;
              el.autoplay = true;
              document.body.appendChild(el);
              audioEls.push(el);
              if (String(pub.source) === 'microphone') {
                tracksByIdentity.set(participant.identity, audio);
                const stored = this.volumes[participant.identity];
                if (stored != null) audio.setVolume(stored);
              }
            } else if (track.kind === Track.Kind.Video) {
              const source = String(pub.source);
              videoTracksByKey.set(`${participant.identity}|${source}`, track as RemoteVideoTrack);
              this.addTile(participant.identity, source, false);
            }
          },
        )
          .on(
            RoomEvent.TrackUnsubscribed,
            (track: RemoteTrack, pub, participant: RemoteParticipant) => {
              if (track.kind === Track.Kind.Audio) {
                tracksByIdentity.delete(participant.identity);
              } else if (track.kind === Track.Kind.Video) {
                videoTracksByKey.delete(`${participant.identity}|${String(pub.source)}`);
                this.removeTile(participant.identity, String(pub.source));
              }
              track.detach().forEach((el) => el.remove());
            },
          )
          .on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
            if (pub.track?.kind !== Track.Kind.Video) return;
            const source = String(pub.source);
            localVideoTracks.set(source, pub.track as LocalVideoTrack);
            if (source === 'screen_share') this.screenOn = true;
            else this.cameraOn = true;
            this.addTile(r.localParticipant.identity, source, true);
          })
          .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
            if (pub.track?.kind !== Track.Kind.Video) return;
            const source = String(pub.source);
            localVideoTracks.delete(source);
            if (source === 'screen_share') this.screenOn = false;
            else this.cameraOn = false;
            this.removeTile(r.localParticipant.identity, source);
          })
          .on(RoomEvent.ParticipantConnected, () => this.syncParticipants())
          .on(RoomEvent.ParticipantDisconnected, () => this.syncParticipants())
          .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
            const self = r.localParticipant.identity;
            this.speaking = speakers.map((p) => p.identity).filter((id) => id !== self);
          })
          .on(RoomEvent.Disconnected, () => {
            void this.cleanup();
          });

        await r.connect(url, token);
        await r.localParticipant.setMicrophoneEnabled(true);
        room = r;
        this.active = true;
        this.muted = false;
        this.error = null;
        this.syncParticipants();
      } catch (e: unknown) {
        this.error = e instanceof Error ? e.message : 'could not connect';
        await this.cleanup();
      } finally {
        this.connecting = false;
      }
    },

    syncParticipants() {
      this.participants = room
        ? Array.from(room.remoteParticipants.values()).map((p) => p.identity)
        : [];
    },

    addTile(identity: string, source: string, self: boolean) {
      if (!this.videoTiles.some((t) => t.identity === identity && t.source === source)) {
        this.videoTiles.push({ identity, source, self });
      }
    },
    removeTile(identity: string, source: string) {
      this.videoTiles = this.videoTiles.filter(
        (t) => !(t.identity === identity && t.source === source),
      );
    },

    /** Attach a tile's track to its <video> element. VideoTile calls this on
     *  mount — required for adaptiveStream to actually deliver remote video. */
    attachVideo(identity: string, source: string, el: HTMLVideoElement, self: boolean) {
      const track = self
        ? localVideoTracks.get(source)
        : videoTracksByKey.get(`${identity}|${source}`);
      track?.attach(el);
    },
    detachVideo(identity: string, source: string, el: HTMLVideoElement, self: boolean) {
      const track = self
        ? localVideoTracks.get(source)
        : videoTracksByKey.get(`${identity}|${source}`);
      track?.detach(el);
    },

    /** Set a remote participant's local playback volume (0..1). Persisted so it
     *  survives a track re-subscribe within the same session. */
    setVolume(identity: string, volume: number) {
      const v = Math.max(0, Math.min(1, volume));
      this.volumes[identity] = v;
      tracksByIdentity.get(identity)?.setVolume(v);
    },

    async toggleMute() {
      if (!room) return;
      this.muted = !this.muted;
      await room.localParticipant.setMicrophoneEnabled(!this.muted);
    },

    async toggleCamera() {
      if (!room) return;
      try {
        // Flags + tiles are driven by LocalTrackPublished/Unpublished, so state
        // stays correct even if the device fails or the user revokes permission.
        await room.localParticipant.setCameraEnabled(!this.cameraOn);
      } catch (e: unknown) {
        this.error = e instanceof Error ? e.message : 'could not toggle camera';
      }
    },

    async toggleScreen() {
      if (!room) return;
      try {
        // { audio: true } also captures screen/tab audio where the browser+OS
        // allow it (Chrome's "share tab audio"); it silently degrades to
        // video-only otherwise.
        await room.localParticipant.setScreenShareEnabled(!this.screenOn, { audio: true });
      } catch {
        /* user cancelled the screen picker — no-op */
      }
    },

    async leave() {
      await this.cleanup();
    },

    async cleanup() {
      if (room) {
        try {
          await room.disconnect();
        } catch {
          /* already gone */
        }
        room = null;
      }
      audioEls.forEach((el) => el.remove());
      audioEls = [];
      tracksByIdentity = new Map();
      videoTracksByKey = new Map();
      localVideoTracks = new Map();
      this.active = false;
      this.connecting = false;
      this.muted = false;
      this.cameraOn = false;
      this.screenOn = false;
      this.participants = [];
      this.speaking = [];
      this.volumes = {};
      this.videoTiles = [];
      this.networkId = null;
      this.target = '';
      this.isGuest = false;
    },
  },
});
