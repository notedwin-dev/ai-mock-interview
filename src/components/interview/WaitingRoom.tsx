"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Mic, MicOff, Video, VideoOff } from "lucide-react";
import type { InvitationView } from "@/lib/interview/invitations";

/**
 * Pre-call waiting room (FR-SETUP-007; TT-8 re-layer). Camera and microphone
 * are used ONLY for a local preview: no frame, audio or recording is ever sent
 * to the AI or the server. Device setup is explicit; "Join Call" is the only
 * action that enters the live room, so nothing auto-starts.
 */
const PRIMARY =
  'inline-flex h-11 items-center gap-2 rounded-full bg-emerald-400 px-6 text-sm font-semibold text-emerald-950 outline-none transition-all hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-emerald-400';
const GHOST =
  "inline-flex h-10 items-center gap-2 rounded-full border border-line px-4 text-sm text-ink-soft outline-none transition-colors hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-emerald-400";

export function WaitingRoom({ token, interview }: { token: string; interview: InvitationView }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraOn, setCameraOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [micId, setMicId] = useState("");
  const [speakerId, setSpeakerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function stopPreview() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  async function enablePreview() {
    setBusy(true);
    setNotice(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: micId ? { deviceId: { exact: micId } } : true,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all);
      const input = all.find((device) => device.kind === "audioinput");
      const output = all.find((device) => device.kind === "audiooutput");
      if (input?.deviceId) setMicId(input.deviceId);
      if (output?.deviceId) setSpeakerId(output.deviceId);
      setCameraOn(true);
    } catch {
      setNotice("Camera or microphone access was not granted. You can still join without a preview.");
    } finally {
      setBusy(false);
    }
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
  }

  function join() {
    // Remember the selected output device for the room; no media crosses the
    // network from this waiting room.
    if (speakerId) sessionStorage.setItem("aimis-speaker-id", speakerId);
    stopPreview();
    router.push(`/i/${token}/room`);
  }

  return (
    <section
      aria-labelledby="waiting-heading"
      className="flex flex-col gap-6">
      <div>
        <h1
          id="waiting-heading"
          className="font-display text-2xl font-semibold tracking-tight text-ink">
          Waiting room
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          {interview.jobRole} · {interview.categoryNameSnapshot} ·{' '}
          {interview.evaluationMode} mode
        </p>
      </div>

      <div className="grid items-start gap-8 md:grid-cols-[minmax(0,1.6fr)_minmax(18rem,0.9fr)]">
        {/* Left: camera preview tile with floating self-controls */}
        <div className="flex flex-col gap-3">
          <div className="relative aspect-video overflow-hidden rounded-3xl border border-line bg-[#0f0f10]">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="h-full w-full object-cover"
              aria-label="Local camera preview"
            />
            <span className="absolute left-4 top-4 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white">
              You · Preview
            </span>
            {!cameraOn ? (
              <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center text-base font-medium text-white">
                Camera is off
              </p>
            ) : null}
            <div className="absolute inset-x-0 bottom-4 flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={toggleMute}
                title={muted ? 'Unmute' : 'Mute'}
                aria-label={muted ? 'Unmute' : 'Mute'}
                aria-pressed={muted}
                className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${muted ? 'bg-rose-200 text-rose-900' : 'bg-white/90 text-neutral-900 hover:bg-white'}`}>
                {muted ? (
                  <MicOff className="h-5 w-5" aria-hidden />
                ) : (
                  <Mic className="h-5 w-5" aria-hidden />
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (cameraOn) stopPreview();
                  else void enablePreview();
                }}
                disabled={busy}
                title={cameraOn ? 'Turn camera off' : 'Turn camera on'}
                aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'}
                aria-pressed={cameraOn}
                className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors disabled:opacity-50 ${cameraOn ? 'bg-white/90 text-neutral-900 hover:bg-white' : 'bg-rose-200 text-rose-900'}`}>
                {busy ? (
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                ) : cameraOn ? (
                  <Video className="h-5 w-5" aria-hidden />
                ) : (
                  <VideoOff className="h-5 w-5" aria-hidden />
                )}
              </button>
            </div>
          </div>

          {/* Device pill row, mirroring the reference layout */}
          {cameraOn ? (
            <div className="flex flex-wrap gap-2">
              <select
                value={micId}
                onChange={(event) => setMicId(event.target.value)}
                aria-label="Microphone"
                className="h-10 max-w-full rounded-full border border-line bg-surface px-4 text-xs text-ink outline-none focus:border-emerald-400/70">
                {devices
                  .filter((d) => d.kind === 'audioinput')
                  .map((d) => (
                    <option
                      key={d.deviceId}
                      value={d.deviceId}>
                      {d.label || 'Microphone'}
                    </option>
                  ))}
              </select>
              <select
                value={speakerId}
                onChange={(event) => setSpeakerId(event.target.value)}
                aria-label="Speaker"
                className="h-10 max-w-full rounded-full border border-line bg-surface px-4 text-xs text-ink outline-none focus:border-emerald-400/70">
                {devices
                  .filter((d) => d.kind === 'audiooutput')
                  .map((d) => (
                    <option
                      key={d.deviceId}
                      value={d.deviceId}>
                      {d.label || 'Speaker'}
                    </option>
                  ))}
              </select>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void enablePreview()}
              disabled={busy}
              className={`${GHOST} justify-center self-start`}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Video className="h-4 w-4" aria-hidden />
              )}
              Enable camera &amp; mic
            </button>
          )}
          <p className="text-xs text-ink-muted">
            Your preview and device checks stay in this browser — nothing is
            sent to the AI until you join.
          </p>
          {notice ? <p className="text-xs text-amber-300">{notice}</p> : null}
        </div>

        {/* Right: the single, intentional action */}
        <div className="flex flex-col gap-4 md:pt-12">
          <h2 className="font-display text-2xl font-semibold tracking-tight text-ink">
            Ready to join?
          </h2>
          <p className="text-sm text-ink-muted">
            Your interview begins when you join. The AI will greet you and
            guide the session from there.
          </p>
          <button
            type="button"
            onClick={join}
            className={`${PRIMARY} w-full justify-center`}>
            Join Call
          </button>
          <Link
            href={`/i/${token}`}
            className="flex h-11 w-full items-center justify-center rounded-full border border-line bg-surface px-6 text-sm font-medium text-ink-soft outline-none transition-colors hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-emerald-400">
            Back to interview details
          </Link>
        </div>
      </div>
    </section>
  );
}
