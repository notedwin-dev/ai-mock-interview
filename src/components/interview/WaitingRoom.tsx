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
export function WaitingRoom({ token, interview }: { token: string; interview: InvitationView }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Generation counter for in-flight getUserMedia requests: joining the call
  // or unmounting invalidates them so a late-resolving stream is stopped
  // instead of leaking device lights and microphone access.
  const previewGenerationRef = useRef(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraOn, setCameraOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const [micId, setMicId] = useState("");
  const [speakerId, setSpeakerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function stopPreview() {
    previewGenerationRef.current += 1;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }

  useEffect(() => () => {
    previewGenerationRef.current += 1;
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  async function enablePreview() {
    setBusy(true);
    setNotice(null);
    const generation = previewGenerationRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: micId ? { deviceId: { exact: micId } } : true,
      });
      if (generation !== previewGenerationRef.current) {
        // The preview was stopped (or the component unmounted) while the
        // request was in flight: release every track, never assign it.
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
      const all = await navigator.mediaDevices.enumerateDevices();
      if (generation !== previewGenerationRef.current) return;
      setDevices(all);
      const input = all.find((device) => device.kind === "audioinput");
      const output = all.find((device) => device.kind === "audiooutput");
      if (input?.deviceId) setMicId(input.deviceId);
      if (output?.deviceId) setSpeakerId(output.deviceId);
      setCameraOn(true);
    } catch {
      // Enumeration or acquisition failed: an acquired stream must not keep
      // running with no way for the user to stop it.
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
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

  function changeMicrophone(nextMicId: string) {
    setMicId(nextMicId);
    // Swap the active preview's audio track to the selected device while
    // preserving the current mute setting; the old track is stopped.
    const stream = streamRef.current;
    if (!stream || !nextMicId) return;
    const replacement = navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: nextMicId } },
    });
    void replacement.then((next) => {
      if (streamRef.current !== stream) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }
      const audioTrack = next.getAudioTracks()[0];
      if (!audioTrack) return;
      audioTrack.enabled = !muted;
      stream.getAudioTracks().forEach((track) => {
        stream.removeTrack(track);
        track.stop();
      });
      stream.addTrack(audioTrack);
      if (videoRef.current) videoRef.current.srcObject = stream;
    });
  }

  function join() {
    stopPreview();
    router.push(`/i/${token}/room`);
  }

  return (
    <section aria-labelledby="waiting-heading" className="flex flex-col gap-6">
      <div>
        <h1 id="waiting-heading" className="font-display text-2xl font-semibold tracking-tight text-ink">
          Waiting room
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          {interview.jobRole} · {interview.categoryNameSnapshot} · {interview.evaluationMode} mode
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="relative aspect-video overflow-hidden rounded-3xl border border-line bg-black/60">
          <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" aria-label="Local camera preview" />
          {!cameraOn ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center text-sm text-ink-muted">
              <Video className="h-8 w-8" aria-hidden />
              <p>Your preview stays in this browser — it is never sent to the AI.</p>
              <button type="button" onClick={() => void enablePreview()} disabled={busy} className="btn-ghost">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Video className="h-4 w-4" aria-hidden />}
                Enable camera &amp; mic
              </button>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-4 rounded-3xl border border-line bg-surface p-5">
          <h2 className="text-sm font-semibold text-ink">Device checks</h2>
          {cameraOn ? (
            <>
              <label className="flex flex-col gap-1 text-xs text-ink-muted">
                Microphone
                <select value={micId} onChange={(event) => changeMicrophone(event.target.value)} className="h-10 rounded-full border border-line bg-raised px-4 text-sm text-ink">
                  {devices.filter((d) => d.kind === "audioinput").map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || "Microphone"}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-ink-muted">
                Speaker
                <select value={speakerId} onChange={(event) => setSpeakerId(event.target.value)} className="h-10 rounded-full border border-line bg-raised px-4 text-sm text-ink">
                  {devices.filter((d) => d.kind === "audiooutput").map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || "Speaker"}</option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={stopPreview} className="btn-ghost">
                <VideoOff className="h-4 w-4" aria-hidden /> Stop preview
              </button>
            </>
          ) : (
            <p className="text-xs text-ink-muted">Enable devices to check them here.</p>
          )}
          <button type="button" onClick={toggleMute} disabled={!cameraOn} className="btn-ghost">
            {muted ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
            {muted ? "Unmute" : "Mute"}
          </button>
          {notice ? <p className="text-xs text-amber-300">{notice}</p> : null}
          <div className="mt-auto flex flex-col gap-2">
            <button type="button" onClick={join} className="btn-primary">Join Call</button>
            <Link href={`/i/${token}`} className="text-center text-xs text-ink-muted underline decoration-line underline-offset-4">
              Back to interview details
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
