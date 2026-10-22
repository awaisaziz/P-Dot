"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LocalTime, useIsClient } from "@/components/ui/LocalTime";
import { ApiError, errorMessage } from "@/lib/api-client";
import { MAX_DOCUMENT_CHARS, MAX_DOCUMENT_TITLE_CHARS } from "@/lib/limits";
import type { DocumentDTO, DocumentMediaType, DocumentStatus } from "@/types/api";
import { deleteDocument, fetchDocuments, uploadDocument } from "./api";
import { DOCUMENT_ACCEPT, MEDIA_TYPE_LABELS, describeFile, fileSizeProblem, textProblem } from "./file";

interface PendingUpload {
  fileName: string;
  title: string;
  mediaType: DocumentMediaType;
  text: string;
}

const STATUS_PILLS: Record<DocumentStatus, { label: string; className: string }> = {
  processing: { label: "Processing", className: "status-proposed" },
  ready: { label: "Ready", className: "status-executed" },
  failed: { label: "Failed", className: "status-failed" },
};

function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.code === "not_configured") {
    return "Adding documents needs the Nebius embedding service, which is not configured on this server.";
  }
  return errorMessage(err, fallback);
}

/** A failed upload can leave a "failed" document behind (the server keeps the row), so the list is reloaded. */
function mayHaveSaved(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  return err.status === 0 || (err.status >= 429 && err.code !== "not_configured");
}

/**
 * Documents: plain text or Markdown the user added. Nothing is
 * sent until the user checks the title and presses Add; deleting removes the
 * text and its search index at once.
 */
export function DocumentsPanel({ initialDocuments }: { initialDocuments: DocumentDTO[] }) {
  const router = useRouter();
  // The server does not know the viewer's locale, so numbers get separators only after hydration.
  const isClient = useIsClient();
  const count = (n: number) => (isClient ? n.toLocaleString() : String(n));
  const [documents, setDocuments] = useState(initialDocuments);
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  /** Shows the error, or sends the user to sign in. Returns true when the session is gone. */
  function fail(err: unknown, fallback: string): boolean {
    if (err instanceof ApiError && err.status === 401) {
      router.replace("/login?next=/memory");
      return true;
    }
    setError(friendlyError(err, fallback));
    return false;
  }

  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Cleared so that choosing the same file again still counts as a change.
    input.value = "";
    if (!file) return;
    setError(null);
    setPending(null);
    const described = describeFile(file.name);
    const problem = "error" in described ? described.error : fileSizeProblem(file.size);
    if ("error" in described || problem) {
      setError(problem);
      return;
    }
    setReading(true);
    try {
      const text = await file.text();
      const textError = textProblem(text);
      if (textError) setError(textError);
      else setPending({ fileName: file.name, title: described.title, mediaType: described.mediaType, text });
    } catch {
      setError("Could not read this file.");
    } finally {
      setReading(false);
    }
  }

  async function reload() {
    try {
      setDocuments(await fetchDocuments());
    } catch {
      // The upload error is already shown; the list stays as it was.
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!pending || uploading) return;
    const title = pending.title.trim();
    if (!title) {
      setError("Give the document a title.");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const added = await uploadDocument({ title, mediaType: pending.mediaType, text: pending.text });
      setDocuments((list) => [added, ...list.filter((d) => d.id !== added.id)]);
      setPending(null);
      setStatus(`Added “${added.title}”.`);
    } catch (err) {
      if (!fail(err, "Could not add the document.") && mayHaveSaved(err)) void reload();
    } finally {
      setUploading(false);
    }
  }

  async function remove(document: DocumentDTO) {
    setBusyId(document.id);
    setError(null);
    try {
      await deleteDocument(document.id);
    } catch (err) {
      // Already gone counts as deleted.
      if (!(err instanceof ApiError && err.status === 404)) {
        fail(err, "Could not delete the document.");
        setBusyId(null);
        return;
      }
    }
    setDocuments((list) => list.filter((d) => d.id !== document.id));
    setConfirmId(null);
    setBusyId(null);
    setStatus(`Deleted “${document.title}”.`);
  }

  return (
    <section id="documents" className="panel" aria-labelledby="documents-heading" aria-busy={uploading}>
      <div className="panel-heading">
        <h2 id="documents-heading">Documents</h2>
        <span className="muted small">
          {documents.length === 0 ? "None yet" : `${documents.length} ${documents.length === 1 ? "document" : "documents"}`}
        </span>
      </div>
      <p className="muted small">
        Text and Markdown files P-Dot can search, up to {count(MAX_DOCUMENT_CHARS)} characters each; the text goes to
        Nebius once to index it.
      </p>

      {pending ? (
        <form className="document-pending stack" onSubmit={(event) => void add(event)} aria-label="Add this document">
          <div className="field">
            <label htmlFor="document-title">Title</label>
            <input
              id="document-title"
              className="form-control"
              type="text"
              value={pending.title}
              maxLength={MAX_DOCUMENT_TITLE_CHARS}
              autoFocus
              onChange={(event) => setPending({ ...pending, title: event.target.value })}
            />
          </div>
          <p className="hint">
            {pending.fileName} · {MEDIA_TYPE_LABELS[pending.mediaType]} · {count(pending.text.length)} characters
          </p>
          <div className="actions">
            <button type="submit" className="button button-primary" disabled={uploading || !pending.title.trim()}>
              {uploading ? "Adding…" : "Add document"}
            </button>
            <button type="button" className="button" disabled={uploading} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <input
            id="document-file"
            className="file-input visually-hidden"
            type="file"
            accept={DOCUMENT_ACCEPT}
            disabled={reading}
            onChange={(event) => void choose(event)}
          />
          <label htmlFor="document-file" className="button" aria-disabled={reading || undefined}>
            {reading ? "Reading…" : "Choose a file"}
          </label>
          <span className="hint">.txt or .md</span>
        </div>
      )}

      {error && (
        <p className="alert alert-error small" role="alert">
          {error}
        </p>
      )}

      {documents.length > 0 && (
        <ul className="document-list">
          {documents.map((document) => {
            const pill = STATUS_PILLS[document.status];
            return (
              <li key={document.id} className="document-item">
                <div className="document-body">
                  <span className="document-title">{document.title}</span>
                  <span className="hint">
                    {MEDIA_TYPE_LABELS[document.mediaType]} · {count(document.charCount)} characters ·{" "}
                    <LocalTime iso={document.createdAt} style="date" />
                  </span>
                  {document.status === "failed" && (
                    <span className="hint">Could not be processed; delete it and add the file again.</span>
                  )}
                  {document.status === "processing" && (
                    <span className="hint">Still processing; if it stays stuck, delete it and add the file again.</span>
                  )}
                </div>
                <span className={`status-pill ${pill.className}`}>{pill.label}</span>
                {confirmId === document.id ? (
                  <div className="actions" role="group" aria-label={`Delete “${document.title}”?`}>
                    <span className="small">Delete this document? Its text goes at once.</span>
                    <button
                      type="button"
                      className="button button-danger button-small"
                      disabled={busyId === document.id}
                      onClick={() => void remove(document)}
                    >
                      {busyId === document.id ? "Deleting…" : "Delete"}
                    </button>
                    <button
                      type="button"
                      className="button button-small"
                      disabled={busyId === document.id}
                      onClick={() => setConfirmId(null)}
                    >
                      Keep it
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="button button-small button-danger"
                    aria-label={`Delete “${document.title}”`}
                    onClick={() => setConfirmId(document.id)}
                  >
                    Delete
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="visually-hidden" role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}
