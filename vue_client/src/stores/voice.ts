// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Voice call session for the web client. The browser IS the WebRTC engine here,
// so unlike the native client this is thin: get a room-scoped token (from
// /api/voice/token for members, or /api/voice/guest-token for a public guest),
// connect the LiveKit room, publish the mic, and let livekit-client attach
// <audio> elements for remote participants (they autoplay).
//
// Bundle bloat, addressed: livekit-client is ~500 KB, and voice is off by
// default on most instances. So it is pulled in with a dynamic import() inside
// the connect path — Vite splits it into its own chunk fetched only when a user
// actually places a call. It never touches the initial page load.
//
// The Room, attached <audio> elements, and per-identity RemoteAudioTracks are
// held module-scoped, NOT in Pinia state: they are non-serializable and must not
// be wrapped in Vue's reactive proxy, which would break livekit's object
// identity. State carries only the primitives the UI renders.

import { defineStore } from 'pinia';
import type {
  Room,
  RemoteTrack,
  RemoteAudioTrack,
  RemoteParticipant,
  Participant,
} from 'livekit-client';
import { api } from '../api.js';

interface VoiceTokenResponse {
  token: string;
  room: string;
  url: string;
}

// Non-reactive session handles (see header note).
let room: Room | null = null;
let audioEls: HTMLAudioElement[] = [];
// identity → its remote audio track, so we can set per-participant volume.
let tracksByIdentity = new Map<string, RemoteAudioTrack>();

export const useVoiceStore = defineStore('voice', {
  state: () => ({
    active: false,
    connecting: false,
    muted: false,
    // Human label for what's being called, e.g. "#dev".
    label: '',
    // The channel/DM this call belongs to (for moderation + guest-link calls).
    // Null for a guest session, which has no owning network.
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
          (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
            if (track.kind === Track.Kind.Audio) {
              const audio = track as RemoteAudioTrack;
              tracksByIdentity.set(participant.identity, audio);
              const stored = this.volumes[participant.identity];
              if (stored != null) audio.setVolume(stored);
              const el = audio.attach() as HTMLAudioElement;
              el.autoplay = true;
              document.body.appendChild(el);
              audioEls.push(el);
            }
          },
        )
          .on(
            RoomEvent.TrackUnsubscribed,
            (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
              tracksByIdentity.delete(participant.identity);
              track.detach().forEach((el) => el.remove());
            },
          )
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
      this.active = false;
      this.connecting = false;
      this.muted = false;
      this.participants = [];
      this.speaking = [];
      this.volumes = {};
      this.networkId = null;
      this.target = '';
      this.isGuest = false;
    },
  },
});
