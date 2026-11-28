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
 *
 * Merge note: the earlier mic-in-preview implementation was superseded by this
 * camera-only preview + device-preference + autojoin flow; its request-generation
 * guards survive here as `cameraRequestRef` / `mountedRef`.
 */
export function WaitingRoom({ token, interview }: { token: string; interview: InvitationView }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraRequestRef = useRef(0);
  const mountedRef = useRef(true);
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

  useEffect(() => {
    // StrictMode replays setup after cleanup: restore the mounted flag so a
    // new camera request is not discarded by its own cleanup generation.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cameraRequestRef.current += 1;
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function stopCamera() {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }

  async function startCamera(deviceId = cameraId) {
    const request = ++cameraRequestRef.current;
    setBusy(true);
    setNotice(null);
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      // A newer request or an unmount superseded this one: stop its tracks so
      // the camera light does not stay on after navigating away.
      if (request !== cameraRequestRef.current || !mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      cameraStreamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraOn(true);
      loadDevices();
    } catch {
      if (request === cameraRequestRef.current && mountedRef.current) {
        setNotice("Camera access was not granted. You can still join without a preview.");
      }
    } finally {
      if (request === cameraRequestRef.current && mountedRef.current) setBusy(false);
    }
  }

  function toggleCamera() {
    if (cameraOn) stopCamera();
    else void startCamera();
  }

  function toggleMute() {
    // Mic state is a preference for the live room ΓÇö the waiting room never
    // captures audio. It is independent of the camera preview.
    setMuted((current) => !current);
  }

  function changeCamera(deviceId: string) {
    setCameraId(deviceId);
    if (cameraOn && !busy) void startCamera(deviceId);
  }

  function join() {
    saveDevicePreferences({ micId: micId || null, speakerId: speakerId || null, muted });
    stopCamera();
    // The query flag survives the route transition; the room connects on mount.
    router.push(`/interview/${token}/room?autojoin=1`);
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
          {interview.jobRole} ┬╖ {interview.categoryNameSnapshot} ┬╖{" "}
          {evaluationModeLabel(interview.evaluationMode)} mode
        </p>
        {interview.scheduledAt ? (
          <p className="mt-1 text-sm text-ink-muted">
            Scheduled for {new Intl.DateTimeFormat("en-GB", {
              day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
            }).format(new Date(interview.scheduledAt))} · you can still join now or come back later.
          </p>
        ) : null}
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
              You ┬╖ Preview
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
                aria-label="Microphone"
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
                aria-label="Camera"
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

          {/* Device pills ΓÇö always available and independent of the camera. */}
          <div className="flex flex-wrap gap-2">
            <label className="relative flex items-center">
              <Mic className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-ink-muted" aria-hidden />
              <span className="sr-only">Microphone</span>
              <select
                value={micId}
                onChange={(event) => setMicId(event.target.value)}
                aria-label="Microphone input"
                className="device-pill">
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
                className="device-pill">
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
                disabled={busy}
                aria-label="Camera"
                className="device-pill">
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
          <button
            type="button"
            onClick={join}
            disabled={busy}
            className="btn-primary w-full justify-center px-6">
            Join now
          </button>
          <Link
            href="/dashboard"
            className="flex h-11 w-full items-center justify-center rounded-full border border-line bg-surface px-6 text-sm font-medium text-ink-soft outline-none transition-colors hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-emerald-400">
            Back to Dashboard
          </Link>
        </div>
      </div>
    </section>
  );
}
