// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Voice call session for the web client. The browser IS the WebRTC engine here,
// so unlike the native client this is thin: mint a room-scoped token from
// /api/voice/token, connect the LiveKit room, publish the mic, and let
// livekit-client attach <audio> elements for remote participants (they autoplay).
//
// Bundle bloat, addressed: livekit-client is ~500 KB, and voice is off by
// default on most instances. So it is pulled in with a dynamic import() inside
// startCall — Vite splits it into its own chunk that is fetched only when a user
// actually places a call. It never touches the initial page load. `import type`
// is erased at build time, so the type-only imports below add nothing to any
// bundle.
//
// The Room and the attached <audio> elements are held module-scoped, NOT in
// Pinia state: they are non-serializable and must not be wrapped in Vue's
// reactive proxy, which would break livekit's internal object identity. State
// carries only the primitives the UI renders.

import { defineStore } from 'pinia';
import type { Room, RemoteTrack, Participant } from 'livekit-client';
import { api } from '../api.js';

interface VoiceTokenResponse {
  token: string;
  room: string;
  url: string;
}

// Non-reactive session handles (see header note).
let room: Room | null = null;
let audioEls: HTMLAudioElement[] = [];

export const useVoiceStore = defineStore('voice', {
  state: () => ({
    active: false,
    connecting: false,
    muted: false,
    // Human label for what's being called, e.g. "#dev".
    label: '',
    // Remote participant identities (our IRC-nick convention).
    participants: [] as string[],
    // Subset of `participants` currently detected as speaking.
    speaking: [] as string[],
    error: null as string | null,
  }),
  actions: {
    async startCall(networkId: number, target: string, label: string) {
      if (this.active || this.connecting) return;
      this.connecting = true;
      this.error = null;
      this.label = label;
      try {
        // Token first, so a 503/403/404 fails fast without paying to load the SDK.
        const { token, url } = await api<VoiceTokenResponse>('/api/voice/token', {
          method: 'POST',
          body: { networkId, target },
        });

        // Lazy chunk: livekit-client only lands over the network at first call.
        const { Room, RoomEvent, Track } = await import('livekit-client');

        const r = new Room({ adaptiveStream: true, dynacast: true });
        r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
          if (track.kind === Track.Kind.Audio) {
            const el = track.attach() as HTMLAudioElement;
            el.autoplay = true;
            document.body.appendChild(el);
            audioEls.push(el);
          }
        })
          .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
            track.detach().forEach((el) => el.remove());
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
        this.syncParticipants();
      } catch (e: any) {
        this.error = e?.message || 'could not start call';
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
      this.active = false;
      this.connecting = false;
      this.muted = false;
      this.participants = [];
      this.speaking = [];
    },
  },
});
