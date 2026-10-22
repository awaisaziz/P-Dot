"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

// Minimal typings for the browser's Web Speech API (not in the TypeScript DOM lib).
interface SpeechResultAlternative {
  transcript: string;
}
interface SpeechResult {
  isFinal: boolean;
  0: SpeechResultAlternative;
}
export interface SpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<SpeechResult>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Whether this page may use the microphone at all (the Permissions-Policy
 * header in next.config.ts). Browsers without the API are assumed to allow it.
 */
function microphoneAllowedByPage(): boolean {
  const doc = document as Document & {
    permissionsPolicy?: { allowsFeature(feature: string): boolean };
    featurePolicy?: { allowsFeature(feature: string): boolean };
  };
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  return policy ? policy.allowsFeature("microphone") : true;
}

const subscribeNothing = () => () => {};

/** The final words in a result event, from the first new result on. */
export function finalText(event: SpeechResultEvent): string {
  let text = "";
  for (let i = event.resultIndex; i < event.results.length; i += 1) {
    const result = event.results[i];
    if (result?.isFinal) text += result[0].transcript;
  }
  return text.trim();
}

/** Words heard but not settled yet, shown while the user speaks and never put into the message. */
export function interimText(event: SpeechResultEvent): string {
  let text = "";
  for (let i = event.resultIndex; i < event.results.length; i += 1) {
    const result = event.results[i];
    if (result && !result.isFinal) text += result[0].transcript;
  }
  return text.trim();
}

const ERROR_MESSAGES: Record<string, string> = {
  "not-allowed": "Microphone blocked: Allow the microphone for this site in your browser settings, then retry.",
  "service-not-allowed": "Speech recognition is off in this browser; turn it on in its settings or type instead.",
  "no-speech": "No speech heard; try again.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition needs an internet connection.",
  "language-not-supported": "This browser cannot recognise English speech.",
};

/** What to tell the user for a recognition error. Null when it needs no message (dictation was stopped on purpose). */
export function dictationErrorMessage(code: string): string | null {
  if (code === "aborted") return null;
  return ERROR_MESSAGES[code] ?? "Dictation stopped unexpectedly; try again.";
}

/** The draft with a dictated phrase added after a space, cut at the message length limit. */
export function appendDictation(draft: string, text: string, maxChars: number): string {
  const next = draft.trim() ? `${draft.trimEnd()} ${text}` : text;
  return next.slice(0, maxChars);
}

/**
 * Chrome on Android repeats earlier words when recognition runs continuously,
 * so there it listens for one phrase per tap. Elsewhere it keeps listening
 * until the user taps again.
 */
export function listensContinuously(userAgent: string): boolean {
  return !/Android/i.test(userAgent);
}

/**
 * Speech-to-text in English using the browser's own speech recognition. Final
 * phrases are passed to `onText`; the user reviews and sends the message
 * themselves. P-Dot's servers never receive the audio (the browser vendor's
 * speech service may process it).
 */
export function useDictation(onText: (text: string) => void) {
  const supported = useSyncExternalStore(
    subscribeNothing,
    () => getCtor() !== null && microphoneAllowedByPage(),
    () => false,
  );
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onTextRef = useRef(onText);

  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  useEffect(() => () => recognitionRef.current?.abort(), []);

  /** Stops at once and drops anything still being recognised, for example when the message is sent. */
  const cancel = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    recognitionRef.current = null;
    recognition.abort();
    setListening(false);
    setInterim("");
  }, []);

  const toggle = useCallback(() => {
    if (recognitionRef.current) {
      // Stop listening, but let the last phrase arrive.
      recognitionRef.current.stop();
      return;
    }
    const Ctor = getCtor();
    if (!Ctor) return;

    const recognition = new Ctor();
    // Handlers check this, so a cancelled recognition cannot add text afterwards.
    const isCurrent = () => recognitionRef.current === recognition;
    recognition.lang = "en-US";
    recognition.continuous = listensContinuously(navigator.userAgent);
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      if (!isCurrent()) return;
      const text = finalText(event);
      if (text) onTextRef.current(text);
      setInterim(interimText(event));
    };
    recognition.onerror = (event) => {
      if (!isCurrent()) return;
      const message = dictationErrorMessage(event.error);
      if (message) setError(message);
    };
    recognition.onend = () => {
      if (!isCurrent()) return;
      recognitionRef.current = null;
      setListening(false);
      setInterim("");
    };

    setError(null);
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      recognitionRef.current = null;
      setError("Dictation could not start; try again.");
    }
  }, []);

  return { supported, listening, interim, error, toggle, cancel };
}
