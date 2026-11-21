"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Mic, MicOff, Video, VideoOff, Volume2 } from "lucide-react";
import type { InvitationView } from "@/lib/interview/invitations";
import { saveDevicePreferences } from "@/lib/interview/device-preferences";
import { evaluationModeLabel } from "@/lib/interview/labels";

/**
 * Pre-call waiting room (FR-SETUP-007). The camera is a LOCAL-ONLY preview:
 * turning it on or off never touches the microphone or speaker. Mic and speaker
 * choices are preferences carried into the live room, where the mic is actually
 * captured. Nothing is sent to the AI until "Join now".
 */
const PRIMARY =
  "inline-flex h-11 items-center gap-2 rounded-full bg-emerald-400 px-6 text-sm font-semibold text-emerald-950 outline-none transition-all hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-emerald-400";

const PILL =
  "h-10 max-w-full rounded-full border border-line bg-surface pl-8 pr-3 text-xs text-ink outline-none transition-colors focus:border-emerald-400/70";

export function WaitingRoom({ token, interview }: { token: string; interview: InvitationView }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraOn, setCameraOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [micId, setMicId] = useState("");
  const [speakerId, setSpeakerId] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadDevices = useCallback(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    void navigator.mediaDevices.enumerateDevices()
      .then((all) => {
        setDevices(all);
        // Functional updates keep this callback dependency-free: defaults are
        // only filled in when no device is selected yet.
        setMicId((current) => current || all.find((d) => d.kind === "audioinput")?.deviceId || "");
        setSpeakerId((current) => current || all.find((d) => d.kind === "audiooutput")?.deviceId || "");
        setCameraId((current) => current || all.find((d) => d.kind === "videoinput")?.deviceId || "");
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  useEffect(() => () => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  function stopCamera() {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }

  async function startCamera(deviceId = cameraId) {
    setBusy(true);
    setNotice(null);
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      cameraStreamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraOn(true);
      loadDevices();
    } catch {
      setNotice("Camera access was not granted. You can still join without a preview.");
    } finally {
      setBusy(false);
    }
  }

  function toggleCamera() {
    if (cameraOn) stopCamera();
    else void startCamera();
  }

  function toggleMute() {
    // Mic state is a preference for the live room — the waiting room never
    // captures audio. It is independent of the camera preview.
    setMuted((current) => !current);
  }

  function changeCamera(deviceId: string) {
    setCameraId(deviceId);
    if (cameraOn) void startCamera(deviceId);
  }

  function join() {
    saveDevicePreferences({ micId: micId || null, speakerId: speakerId || null, muted });
    stopCamera();
    router.push(`/i/${token}/room`);
  }

  const micOptions = devices.filter((d) => d.kind === "audioinput");
  const speakerOptions = devices.filter((d) => d.kind === "audiooutput");
  const cameraOptions = devices.filter((d) => d.kind === "videoinput");

  return (
    <section aria-labelledby="waiting-heading" className="flex flex-col gap-6">
      <div>
        <h1
          id="waiting-heading"
          className="font-display text-2xl font-semibold tracking-tight text-ink">
          Waiting room
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          {interview.jobRole} · {interview.categoryNameSnapshot} ·{" "}
          {evaluationModeLabel(interview.evaluationMode)} mode
        </p>
      </div>

      <div className="grid items-start gap-8 md:grid-cols-[minmax(0,1.6fr)_minmax(18rem,0.9fr)]">
        {/* Left: local camera preview with independent mic/camera controls */}
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
                title={muted ? "Unmute" : "Mute"}
                aria-label={muted ? "Unmute" : "Mute"}
                aria-pressed={muted}
                className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
                  muted ? "bg-rose-200 text-rose-900" : "bg-white/90 text-neutral-900 hover:bg-white"
                }`}>
                {muted ? <MicOff className="h-5 w-5" aria-hidden /> : <Mic className="h-5 w-5" aria-hidden />}
              </button>
              <button
                type="button"
                onClick={toggleCamera}
                disabled={busy}
                title={cameraOn ? "Turn camera off" : "Turn camera on"}
                aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}
                aria-pressed={cameraOn}
                className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors disabled:opacity-50 ${
                  cameraOn ? "bg-white/90 text-neutral-900 hover:bg-white" : "bg-rose-200 text-rose-900"
                }`}>
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

          {/* Device pills — always available and independent of the camera. */}
          <div className="flex flex-wrap gap-2">
            <label className="relative flex items-center">
              <Mic className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-ink-muted" aria-hidden />
              <span className="sr-only">Microphone</span>
              <select
                value={micId}
                onChange={(event) => setMicId(event.target.value)}
                aria-label="Microphone input"
                className={PILL}>
                {micOptions.length === 0 ? <option value="">Microphone</option> : null}
                {micOptions.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Microphone ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="relative flex items-center">
              <Volume2 className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-ink-muted" aria-hidden />
              <span className="sr-only">Speaker</span>
              <select
                value={speakerId}
                onChange={(event) => setSpeakerId(event.target.value)}
                aria-label="Speaker output"
                className={PILL}>
                {speakerOptions.length === 0 ? <option value="">Speaker</option> : null}
                {speakerOptions.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Speaker ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="relative flex items-center">
              <Video className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-ink-muted" aria-hidden />
              <span className="sr-only">Camera</span>
              <select
                value={cameraId}
                onChange={(event) => changeCamera(event.target.value)}
                aria-label="Camera"
                className={PILL}>
                {cameraOptions.length === 0 ? <option value="">Camera</option> : null}
                {cameraOptions.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Camera ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-ink-muted">
            Camera preview stays in this browser. Microphone and speaker choices
            apply when you join.
          </p>
          {notice ? <p className="text-xs text-amber-300" role="status">{notice}</p> : null}
        </div>

        {/* Right: the single, intentional action */}
        <div className="flex flex-col gap-4 md:pt-12">
          <h2 className="font-display text-2xl font-semibold tracking-tight text-ink">
            Ready to join?
          </h2>
          <p className="text-sm text-ink-muted">No one else is here.</p>
          <p className="text-sm text-ink-muted">
            Your interview begins when you join. Introduce yourself in the room
            to start the conversation.
          </p>
          <button type="button" onClick={join} className={`${PRIMARY} w-full justify-center`}>
            Join now
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
