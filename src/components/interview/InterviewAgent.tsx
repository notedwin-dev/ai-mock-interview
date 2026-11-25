"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Check, Copy, Loader2, RotateCcw, Send } from "lucide-react";
import type { AgentConfig } from "@/lib/interview/agent";

/**
 * Conversational interview creation (FR-SETUP-006/007). The agent gathers
 * purpose, role, job description and strictness through chat; when the
 * server reports a complete configuration the user reviews it and creates
 * the interview directly — no manual setup form is inserted in between.
 * All generation and creation runs server-side through /api/v1/interviews/agent.
 */
interface ChatMessage {
  role: "agent" | "candidate";
  content: string;
}

interface AgentResult {
  reply: string;
  missingFields: string[];
  config: AgentConfig | null;
  ready: boolean;
}

interface ApiError {
  error?: { code: string; message: string };
}

const MAX_MESSAGES = 12;
const WELCOME: ChatMessage = {
  role: "agent",
  content:
    "Hi! I'm your AI Interview Agent. Tell me what you'd like to practise — the purpose, the target role, the job description context and how strict the feedback should be (Supportive, Balanced or Rigorous).",
};

const PRIMARY_PILL =
  "inline-flex h-11 cursor-pointer items-center gap-2 rounded-full bg-emerald-400 px-6 text-sm font-semibold text-emerald-950 outline-none transition-all hover:bg-emerald-300 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-60";
const FIELD_CLASS =
  "h-12 w-full rounded-full border border-line bg-raised px-5 text-sm text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-emerald-400/70 focus:ring-2 focus:ring-emerald-400/20";

const FIELD_LABELS: Record<string, string> = {
  purpose: "purpose",
  jobRole: "target role",
  jobDescription: "job description",
  strictness: "strictness",
};

async function postAgent(body: unknown): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  try {
    const response = await fetch("/api/v1/interviews/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = (text ? JSON.parse(text) : null) as ApiError | null;
    if (!response.ok) {
      return { ok: false, message: parsed?.error?.message ?? "The request could not be completed." };
    }
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, message: "The request could not reach the server." };
  }
}

export function InterviewAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"turn" | "create" | null>(null);
  const [created, setCreated] = useState<{ sessionId: string; path: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function send(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || pending !== null) return;
    if (messages.length >= MAX_MESSAGES) {
      setError("This conversation has reached its limit — start over to continue.");
      return;
    }
    setError(null);
    const nextMessages: ChatMessage[] = [...messages, { role: "candidate", content }];
    setMessages(nextMessages);
    setDraft("");
    setPending("turn");
    const response = await postAgent({ action: "turn", messages: nextMessages });
    setPending(null);
    if (!response.ok) {
      setError(response.message);
      return;
    }
    const data = response.data as { result: AgentResult };
    setResult(data.result);
    setMessages((current) => [...current, { role: "agent", content: data.result.reply }]);
  }

  async function create() {
    if (!result?.config || !result.ready || pending !== null) return;
    setError(null);
    setPending("create");
    const response = await postAgent({
      action: "create",
      config: result.config,
      missingFields: result.missingFields,
    });
    setPending(null);
    if (!response.ok) {
      setError(response.message);
      return;
    }
    const data = response.data as {
      session: { sessionId: string; invitation: { token: string; path: string } };
    };
    setCreated({
      sessionId: data.session.sessionId,
      path: data.session.invitation.path,
      url: `${window.location.origin}${data.session.invitation.path}`,
    });
  }

  async function copyLink() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
    } catch {
      setError("Copy failed — select the link above and copy it manually.");
    }
  }

  function startOver() {
    setMessages([WELCOME]);
    setDraft("");
    setResult(null);
    setError(null);
    setPending(null);
  }

  const atLimit = messages.length >= MAX_MESSAGES;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto rounded-2xl border border-line bg-surface p-4 sm:p-5">
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
              message.role === "agent"
                ? "self-start bg-raised text-ink-soft"
                : "self-end bg-emerald-400/15 text-ink"
            }`}
          >
            <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
              {message.role === "agent" ? "AI Interview Agent" : "You"}
            </span>
            {message.content}
          </div>
        ))}
        {pending === "turn" ? (
          <p className="self-start text-xs text-ink-muted">The agent is thinking…</p>
        ) : null}
      </div>

      {result && result.missingFields.length > 0 ? (
        <p className="text-xs text-amber-300">
          Still gathering: {result.missingFields.map((field) => FIELD_LABELS[field] ?? field).join(", ")}.
        </p>
      ) : null}

      {result?.ready && result.config && !created ? (
        <section aria-label="Generated interview configuration" className="rounded-2xl border border-emerald-400/40 bg-surface p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-ink">Generated interview configuration</h2>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-ink-muted">Purpose</dt><dd className="text-ink">{result.config.purpose}</dd></div>
            <div><dt className="text-xs text-ink-muted">Target role</dt><dd className="text-ink">{result.config.jobRole}</dd></div>
            <div><dt className="text-xs text-ink-muted">Strictness</dt><dd className="text-ink">{result.config.strictness}</dd></div>
            <div><dt className="text-xs text-ink-muted">Category</dt><dd className="text-ink">{result.config.category}</dd></div>
            {result.config.jobDescription ? (
              <div className="sm:col-span-2"><dt className="text-xs text-ink-muted">Job description</dt><dd className="whitespace-pre-wrap text-ink">{result.config.jobDescription}</dd></div>
            ) : null}
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void create()} disabled={pending !== null} className={PRIMARY_PILL}>
              {pending === "create" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Create interview
            </button>
            <span className="text-xs text-ink-muted">The interview is created ready, and never starts automatically.</span>
          </div>
        </section>
      ) : null}

      {created ? (
        <section aria-label="Invitation link" className="rounded-2xl border border-emerald-400/40 bg-surface p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-ink">Interview created — ready to share</h2>
          <p className="mt-1 text-xs text-ink-muted">
            The interview is scheduled and will not start automatically. Share this link
            with your interviewee; you can revoke or replace it from your room.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="block min-w-0 max-w-full truncate rounded-full bg-raised px-4 py-2 text-xs text-ink">
              {created.url}
            </code>
            <button type="button" onClick={() => void copyLink()} className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-line px-4 text-sm text-ink-soft outline-none transition-colors hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-emerald-400">
              {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href={created.path} className="text-sm font-medium text-emerald-400 underline decoration-emerald-400/40 underline-offset-4">
              Preview confirmation page
            </Link>
            <Link href={`/dashboard/interview/${created.sessionId}`} className="text-sm text-ink-soft underline decoration-line underline-offset-4">
              Open owner room
            </Link>
          </div>
        </section>
      ) : null}

      {error ? <p className="text-sm text-red-400" role="alert">{error}</p> : null}

      {!result?.ready && !created ? (
        <form onSubmit={(event) => void send(event)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">Your reply</span>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className={FIELD_CLASS}
              placeholder="Tell the agent about your interview…"
              maxLength={5000}
              disabled={atLimit || pending !== null}
              aria-label="Your reply to the interview agent"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={!draft.trim() || atLimit || pending !== null} className={PRIMARY_PILL}>
              <Send className="h-4 w-4" aria-hidden />
              Send
            </button>
            <button type="button" onClick={startOver} disabled={pending !== null} className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-full border border-line px-5 text-sm text-ink-soft outline-none transition-colors hover:border-ink-muted focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-50">
              <RotateCcw className="h-4 w-4" aria-hidden />
              Start over
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
