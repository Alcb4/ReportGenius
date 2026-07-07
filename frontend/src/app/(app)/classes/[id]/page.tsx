"use client";

import { useEffect, useState, useRef, useMemo, KeyboardEvent, FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch, APIError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Student {
  id: string;
  first_name: string;
  last_name: string | null;
  student_ref_id: string | null;
  gender: string | null;
  created_at: string;
}

interface Session {
  id: string;
  name: string;
  topics_covered: string[];
  tone: string;
  length: string;
  status: string;
  created_at: string;
  updated_at: string;
  _count: { disciplines: number; reports: number };
}

interface Test {
  id: string;
  name: string;
  topics: string[];
  max_mark: number;
  grade_boundaries: Record<string, number>;
  created_at: string;
  _count: { results: number };
}

interface ClassListItem {
  id: string;
  name: string;
  year_group: string | null;
  subject: string | null;
  archived: boolean;
  _count: { students: number };
}

interface ClassDetail {
  id: string;
  name: string;
  year_group: string | null;
  subject: string | null;
  archived: boolean;
  students: Student[];
  sessions: Session[];
}

interface DisciplineTemplate {
  id: string;
  name: string;
  is_default: boolean;
}

interface DisciplineGroup {
  category: string;
  disciplines: DisciplineTemplate[];
}

interface DisciplineTemplatesResponse {
  data: DisciplineGroup[];
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: "bg-gray-100 text-gray-600",
    in_progress: "bg-yellow-100 text-yellow-700",
    complete: "bg-green-100 text-green-700",
  };
  const cls = map[status] ?? "bg-gray-100 text-gray-600";
  const label = status === "in_progress" ? "In Progress" : status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

// ── Confirm dialog ────────────────────────────────────────────────────────────

function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  confirmLabel = "Confirm",
  danger = true,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  danger?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
        <p className="text-sm text-gray-700 mb-5">{message}</p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-md text-sm font-semibold text-white transition ${
              danger ? "bg-red-600 hover:bg-red-700" : "bg-indigo-600 hover:bg-indigo-700"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tag input (topics) ────────────────────────────────────────────────────────

function TagInput({
  tags,
  onChange,
  placeholder,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");

  function addTag() {
    const trimmed = input.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
    setInput("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    }
  }

  function removeTag(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? "Type and press Enter"}
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
        />
        <button
          type="button"
          onClick={addTag}
          className="px-3 py-2 rounded-md bg-gray-100 text-sm font-medium text-gray-700 hover:bg-gray-200 transition"
        >
          Add
        </button>
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1.5 bg-indigo-50 text-indigo-700 text-sm px-3 py-1 rounded-full"
            >
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="text-indigo-400 hover:text-indigo-700 transition"
                aria-label={`Remove ${tag}`}
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Create Session Modal ──────────────────────────────────────────────────────

function CreateSessionModal({
  classId,
  onClose,
  onCreated,
}: {
  classId: string;
  onClose: () => void;
  onCreated: (session: Session) => void;
}) {
  const [name, setName] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [length, setLength] = useState<"short" | "medium" | "long">("medium");
  const [tone, setTone] = useState<"gentle" | "balanced" | "direct">("balanced");
  const [templates, setTemplates] = useState<DisciplineGroup[]>([]);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<Set<string>>(new Set());
  const [customInput, setCustomInput] = useState("");
  const [customDisciplines, setCustomDisciplines] = useState<string[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load discipline templates on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = await apiFetch<DisciplineTemplatesResponse>("/api/v1/discipline-templates");
        if (!cancelled) {
          setTemplates(result.data);
          // Leave selectedTemplateIds empty — teacher selects what they want
        }
      } catch {
        // Non-fatal — disciplines are optional
      } finally {
        if (!cancelled) setLoadingTemplates(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  function toggleTemplate(id: string) {
    setSelectedTemplateIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(category: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  function addCustomDiscipline() {
    const trimmed = customInput.trim();
    if (trimmed && !customDisciplines.includes(trimmed)) {
      setCustomDisciplines((prev) => [...prev, trimmed]);
    }
    setCustomInput("");
  }

  function removeCustomDiscipline(name: string) {
    setCustomDisciplines((prev) => prev.filter((d) => d !== name));
  }

  function removeSelectedTemplate(id: string) {
    setSelectedTemplateIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  // Build combined selected chips for display
  const selectedTemplateNames: { id: string; name: string }[] = [];
  for (const group of templates) {
    for (const d of group.disciplines) {
      if (selectedTemplateIds.has(d.id)) {
        selectedTemplateNames.push({ id: d.id, name: d.name });
      }
    }
  }

  // Separate "General" group from expandable groups
  const generalGroup = templates.find((g) => g.category === "General");
  const otherGroups = templates.filter((g) => g.category !== "General");

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) { setError("Session name is required."); return; }
    setError(null);
    setLoading(true);

    try {
      interface CreateSessionResponse { data: Session }
      const result = await apiFetch<CreateSessionResponse>(
        `/api/v1/classes/${classId}/sessions`,
        {
          method: "POST",
          body: {
            name: name.trim(),
            topics_covered: topics,
            length,
            tone,
            templateDisciplineIds: Array.from(selectedTemplateIds),
            customDisciplines: customDisciplines.map((n) => ({ name: n })),
          },
        }
      );
      onCreated(result.data);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to create session.");
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 my-auto">
        {/* Modal header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">New Report Session</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div className="px-6 py-5 space-y-6 max-h-[70vh] overflow-y-auto">
            {/* Session name */}
            <div>
              <label htmlFor="session-name" className="block text-sm font-medium text-gray-700 mb-1">
                Session name <span className="text-red-500">*</span>
              </label>
              <input
                id="session-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="End of Term 1"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
              />
            </div>

            {/* Topics covered */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Topics covered
              </label>
              <TagInput
                tags={topics}
                onChange={setTopics}
                placeholder="Type a topic and press Enter"
              />
            </div>

            {/* Report length */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Report length</label>
              <div className="flex gap-3">
                {(["short", "medium", "long"] as const).map((l) => (
                  <label
                    key={l}
                    className={`flex-1 flex flex-col items-center p-3 rounded-lg border cursor-pointer transition text-center ${
                      length === l
                        ? "border-indigo-500 bg-indigo-50"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="length"
                      value={l}
                      checked={length === l}
                      onChange={() => setLength(l)}
                      className="sr-only"
                    />
                    <span className="text-sm font-medium text-gray-800 capitalize">{l}</span>
                    <span className="text-xs text-gray-400 mt-0.5">
                      {l === "short" ? "~100w" : l === "medium" ? "~200w" : "~350w"}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Tone */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Tone</label>
              <div className="flex gap-3">
                {([
                  { value: "gentle" as const, label: "Gentle", hint: "Positive language, focuses on strengths" },
                  { value: "balanced" as const, label: "Balanced", hint: "Mix of praise and constructive feedback" },
                  { value: "direct" as const, label: "Direct", hint: "Clear strengths + direct areas for improvement" },
                ]).map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setTone(t.value)}
                    title={t.hint}
                    className={`flex-1 px-4 py-3 rounded-lg border text-sm font-medium transition text-center ${
                      tone === t.value
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                        : "border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700"
                    }`}
                  >
                    {tone === t.value ? "●" : "○"} {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Disciplines */}
            <div>
              <p className="text-sm font-medium text-gray-700 mb-3">Disciplines</p>

              {loadingTemplates ? (
                <div className="space-y-2 animate-pulse">
                  {[1, 2, 3, 4].map((n) => (
                    <div key={n} className="h-8 bg-gray-100 rounded-md" />
                  ))}
                </div>
              ) : (
                <div className="space-y-4">
                  {/* General defaults */}
                  {generalGroup && (
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                        General
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        {generalGroup.disciplines.map((d) => (
                          <label
                            key={d.id}
                            className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer transition ${
                              selectedTemplateIds.has(d.id)
                                ? "border-indigo-500 bg-indigo-50"
                                : "border-gray-200 hover:border-gray-300"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={selectedTemplateIds.has(d.id)}
                              onChange={() => toggleTemplate(d.id)}
                              className="accent-indigo-600 w-4 h-4 shrink-0"
                            />
                            <span className="text-sm text-gray-700">{d.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Expandable groups */}
                  {otherGroups.map((group) => (
                    <div key={group.category}>
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.category)}
                        className="flex items-center justify-between w-full text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 hover:text-gray-700 transition"
                      >
                        <span>{group.category}</span>
                        <svg
                          className={`w-4 h-4 transition-transform ${expandedGroups.has(group.category) ? "rotate-180" : ""}`}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      {expandedGroups.has(group.category) && (
                        <div className="grid grid-cols-2 gap-2">
                          {group.disciplines.map((d) => (
                            <label
                              key={d.id}
                              className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer transition ${
                                selectedTemplateIds.has(d.id)
                                  ? "border-indigo-500 bg-indigo-50"
                                  : "border-gray-200 hover:border-gray-300"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={selectedTemplateIds.has(d.id)}
                                onChange={() => toggleTemplate(d.id)}
                                className="accent-indigo-600 w-4 h-4 shrink-0"
                              />
                              <span className="text-sm text-gray-700">{d.name}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Custom disciplines */}
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      Custom disciplines
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={customInput}
                        onChange={(e) => setCustomInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); addCustomDiscipline(); }
                        }}
                        placeholder="e.g. Drama"
                        className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
                      />
                      <button
                        type="button"
                        onClick={addCustomDiscipline}
                        className="px-3 py-2 rounded-md bg-gray-100 text-sm font-medium text-gray-700 hover:bg-gray-200 transition"
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Selected discipline chips */}
              {(selectedTemplateNames.length > 0 || customDisciplines.length > 0) && (
                <div className="mt-4">
                  <p className="text-xs text-gray-500 mb-2">Selected disciplines:</p>
                  <div className="flex flex-wrap gap-2">
                    {selectedTemplateNames.map((t) => (
                      <span
                        key={t.id}
                        className="inline-flex items-center gap-1.5 bg-indigo-50 text-indigo-700 text-xs px-2.5 py-1 rounded-full"
                      >
                        {t.name}
                        <button
                          type="button"
                          onClick={() => removeSelectedTemplate(t.id)}
                          className="text-indigo-400 hover:text-indigo-700 transition"
                          aria-label={`Remove ${t.name}`}
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </span>
                    ))}
                    {customDisciplines.map((d) => (
                      <span
                        key={d}
                        className="inline-flex items-center gap-1.5 bg-gray-100 text-gray-700 text-xs px-2.5 py-1 rounded-full"
                      >
                        {d}
                        <button
                          type="button"
                          onClick={() => removeCustomDiscipline(d)}
                          className="text-gray-400 hover:text-gray-700 transition"
                          aria-label={`Remove ${d}`}
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          {error && (
            <div className="mx-6 mb-2 rounded-md bg-red-50 border border-red-200 px-4 py-2.5 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim()}
              className="px-5 py-2 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {loading ? "Creating..." : "Create Session"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Inline student form row ───────────────────────────────────────────────────

function AddStudentRow({
  classId,
  onAdded,
  onCancel,
}: {
  classId: string;
  onAdded: (student: Student) => void;
  onCancel: () => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [refId, setRefId] = useState("");
  const [gender, setGender] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  async function handleSave() {
    if (!firstName.trim()) { setError("First name is required."); return; }
    setError(null);
    setLoading(true);
    try {
      const result = await apiFetch<{ data: Student }>(`/api/v1/classes/${classId}/students`, {
        method: "POST",
        body: {
          first_name: firstName.trim(),
          last_name: lastName.trim() || undefined,
          student_ref_id: refId.trim() || undefined,
          gender: gender.trim() || undefined,
        },
      });
      onAdded(result.data);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to add student.");
      setLoading(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") { e.preventDefault(); handleSave(); }
    if (e.key === "Escape") onCancel();
  }

  return (
    <tr className="bg-indigo-50">
      <td className="px-4 py-2">
        <input
          ref={firstRef}
          type="text"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="First name *"
          className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
        />
        {error && <p className="text-xs text-red-600 mt-0.5">{error}</p>}
      </td>
      <td className="px-4 py-2">
        <input
          type="text"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Last name"
          className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
        />
      </td>
      <td className="px-4 py-2">
        <input
          type="text"
          value={refId}
          onChange={(e) => setRefId(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ref ID"
          className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
        />
      </td>
      <td className="px-4 py-2">
        <select
          value={gender}
          onChange={(e) => setGender(e.target.value)}
          className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
        >
          <option value="">—</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
          <option value="other">Other</option>
        </select>
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={loading}
            className="px-3 py-1 rounded bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 disabled:opacity-50 transition"
          >
            {loading ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1 rounded border border-gray-300 text-xs font-medium text-gray-600 hover:bg-gray-50 transition"
          >
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── Student edit row ──────────────────────────────────────────────────────────

function EditStudentRow({
  student,
  onSaved,
  onCancel,
}: {
  student: Student;
  onSaved: (updated: Student) => void;
  onCancel: () => void;
}) {
  const [firstName, setFirstName] = useState(student.first_name);
  const [lastName, setLastName] = useState(student.last_name ?? "");
  const [refId, setRefId] = useState(student.student_ref_id ?? "");
  const [gender, setGender] = useState(student.gender ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!firstName.trim()) { setError("First name is required."); return; }
    setError(null);
    setLoading(true);
    try {
      const result = await apiFetch<{ data: Student }>(`/api/v1/students/${student.id}`, {
        method: "PUT",
        body: {
          first_name: firstName.trim(),
          last_name: lastName.trim() || null,
          student_ref_id: refId.trim() || null,
          gender: gender || null,
        },
      });
      onSaved(result.data);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to update student.");
      setLoading(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") { e.preventDefault(); handleSave(); }
    if (e.key === "Escape") onCancel();
  }

  return (
    <tr className="bg-yellow-50">
      <td className="px-4 py-2">
        <input
          type="text"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
        />
        {error && <p className="text-xs text-red-600 mt-0.5">{error}</p>}
      </td>
      <td className="px-4 py-2">
        <input
          type="text"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
        />
      </td>
      <td className="px-4 py-2">
        <input
          type="text"
          value={refId}
          onChange={(e) => setRefId(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
        />
      </td>
      <td className="px-4 py-2">
        <select
          value={gender}
          onChange={(e) => setGender(e.target.value)}
          className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none"
        >
          <option value="">—</option>
          <option value="male">Male</option>
          <option value="female">Female</option>
          <option value="other">Other</option>
        </select>
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={loading}
            className="px-3 py-1 rounded bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 disabled:opacity-50 transition"
          >
            {loading ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1 rounded border border-gray-300 text-xs font-medium text-gray-600 hover:bg-gray-50 transition"
          >
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── Bulk add textarea modal ───────────────────────────────────────────────────

function BulkAddModal({
  classId,
  onClose,
  onAdded,
}: {
  classId: string;
  onClose: () => void;
  onAdded: (students: Student[]) => void;
}) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Field selection checkboxes
  const [fields, setFields] = useState({
    firstName: true,
    lastName: true,
    refId: true,
    gender: true,
  });

  const activeFieldCount = [fields.firstName, fields.lastName, fields.refId, fields.gender].filter(Boolean).length;

  const placeholder = (() => {
    const examples = [
      fields.firstName ? "Alan" : null,
      fields.lastName ? "Davies" : null,
      fields.refId ? "0001" : null,
      fields.gender ? "M" : null,
    ].filter(Boolean);
    const examples2 = [
      fields.firstName ? "Emma" : null,
      fields.lastName ? "Thompson" : null,
      fields.refId ? "0002" : null,
      fields.gender ? "F" : null,
    ].filter(Boolean);
    return `${examples.join(",")}\n${examples2.join(",")}`;
  })();

  const fieldOrder = [
    { key: "firstName" as const, label: "First Name", required: true },
    { key: "lastName" as const, label: "Last Name", required: false },
    { key: "refId" as const, label: "Ref ID", required: false },
    { key: "gender" as const, label: "Gender", required: false },
  ];

  const activeFields = fieldOrder.filter((f) => fields[f.key]);
  const formatHint = activeFields.map((f) => f.label.toLowerCase().replace(" ", "_")).join(", ");

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) { setError("Enter at least one student."); return; }
    if (lines.length > 100) { setError("Maximum 100 students at a time."); return; }

    const skipped: number[] = [];
    const students = lines.reduce<{ first_name: string; last_name: string; student_ref_id?: string | null; gender?: string | null }[]>((acc, line, idx) => {
      const parts = line.split(",").map((p) => p.trim());

      const getField = (fieldKey: string): string => {
        const fieldIdx = activeFields.findIndex((f) => f.key === fieldKey);
        return (parts[fieldIdx] ?? "").trim();
      };

      const first_name = getField("firstName");
      if (!first_name) {
        skipped.push(idx + 1);
        return acc;
      }

      const last_name = fields.lastName ? getField("lastName") : "";
      const rawId = fields.refId ? getField("refId") : "";
      const student_ref_id = rawId || null;

      const rawGender = fields.gender ? getField("gender").toUpperCase() : "";
      const gender =
        rawGender === "M" ? "M" :
        rawGender === "F" ? "F" :
        rawGender === "OTHER" ? "Other" :
        null;

      acc.push({ first_name, last_name, student_ref_id, gender });
      return acc;
    }, []);

    if (students.length === 0) {
      setError("No valid students found. Each row needs at least a first name.");
      return;
    }

    const warningMsg = skipped.length > 0
      ? `Rows ${skipped.join(", ")} skipped (missing first name). `
      : "";

    setError(null);
    setLoading(true);
    try {
      interface BulkAddResponse { data: Student[]; count: number }
      const result = await apiFetch<BulkAddResponse>(`/api/v1/classes/${classId}/students/bulk`, {
        method: "POST",
        body: { students },
      });
      if (warningMsg) setError(warningMsg);
      onAdded(result.data);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to bulk add students.");
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Bulk Add Students</h2>
          <button onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition" aria-label="Close">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <form onSubmit={handleSubmit} noValidate>
          <div className="px-6 py-5 space-y-4">
            {/* Field selection checkboxes */}
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">Fields to enter</label>
              <div className="flex flex-wrap gap-4">
                {fieldOrder.map((f) => (
                  <label key={f.key} className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={fields[f.key]}
                      onChange={(e) => {
                        if (f.key === "firstName") return; // always on
                        setFields((prev) => ({ ...prev, [f.key]: e.target.checked }));
                      }}
                      disabled={f.key === "firstName"}
                      className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-40"
                    />
                    {f.label}
                    {f.required && <span className="text-xs text-gray-400">(always)</span>}
                  </label>
                ))}
              </div>
            </div>

            <p className="text-sm text-gray-500">
              Paste one student per line. Format: <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">{formatHint}</span>.
              {activeFieldCount === 1 ? " One value per line." : " Separate values with commas."} Maximum 100 at once.
            </p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder={placeholder}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition resize-y"
            />
            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</p>
            )}
          </div>
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !text.trim()}
              className="px-5 py-2 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {loading ? "Adding..." : "Add Students"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Edit class header ─────────────────────────────────────────────────────────

function EditClassModal({
  cls,
  onClose,
  onSaved,
}: {
  cls: ClassDetail;
  onClose: () => void;
  onSaved: (updated: Partial<ClassDetail>) => void;
}) {
  const [name, setName] = useState(cls.name);
  const [yearGroup, setYearGroup] = useState(cls.year_group ?? "");
  const [subject, setSubject] = useState(cls.subject ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) { setError("Class name is required."); return; }
    setError(null);
    setLoading(true);
    try {
      interface UpdateClassResponse { data: ClassDetail }
      const result = await apiFetch<UpdateClassResponse>(`/api/v1/classes/${cls.id}`, {
        method: "PUT",
        body: {
          name: name.trim(),
          year_group: yearGroup.trim() || null,
          subject: subject.trim() || null,
        },
      });
      onSaved({
        name: result.data.name,
        year_group: result.data.year_group,
        subject: result.data.subject,
      });
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to update class.");
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Edit Class</h2>
          <button onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition" aria-label="Close">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <form onSubmit={handleSave} noValidate>
          <div className="px-6 py-5 space-y-4">
            <div>
              <label htmlFor="edit-class-name" className="block text-sm font-medium text-gray-700 mb-1">
                Class name <span className="text-red-500">*</span>
              </label>
              <input
                id="edit-class-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="edit-year" className="block text-sm font-medium text-gray-700 mb-1">Year group</label>
                <input
                  id="edit-year"
                  type="text"
                  value={yearGroup}
                  onChange={(e) => setYearGroup(e.target.value)}
                  placeholder="8"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
                />
              </div>
              <div>
                <label htmlFor="edit-subject" className="block text-sm font-medium text-gray-700 mb-1">Subject</label>
                <input
                  id="edit-subject"
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Science"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
                />
              </div>
            </div>
            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</p>
            )}
          </div>
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim()}
              className="px-5 py-2 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {loading ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Test Modal (Add / Edit) ───────────────────────────────────────────────────

interface BoundaryRow {
  label: string;
  pct: string;
}

function TestModal({
  classId,
  existing,
  onClose,
  onSaved,
}: {
  classId: string;
  existing: Test | null;
  onClose: () => void;
  onSaved: (test: Test) => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [topics, setTopics] = useState<string[]>(existing?.topics ?? []);
  const [maxMark, setMaxMark] = useState(existing ? String(existing.max_mark) : "");
  const [showBoundaries, setShowBoundaries] = useState(
    existing ? Object.keys(existing.grade_boundaries).length > 0 : false
  );
  const [boundaries, setBoundaries] = useState<BoundaryRow[]>(() => {
    if (!existing || Object.keys(existing.grade_boundaries).length === 0) return [];
    return Object.entries(existing.grade_boundaries).map(([label, pct]) => ({
      label,
      pct: String(pct),
    }));
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addBoundary() {
    setBoundaries((prev) => [...prev, { label: "", pct: "" }]);
  }

  function removeBoundary(idx: number) {
    setBoundaries((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateBoundary(idx: number, field: "label" | "pct", value: string) {
    setBoundaries((prev) =>
      prev.map((b, i) => (i === idx ? { ...b, [field]: value } : b))
    );
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) { setError("Test name is required."); return; }
    const markNum = parseInt(maxMark, 10);
    if (!maxMark || isNaN(markNum) || markNum < 1) { setError("Total marks must be a positive integer."); return; }

    // Build grade_boundaries
    const grade_boundaries: Record<string, number> = {};
    for (const row of boundaries) {
      if (!row.label.trim() && !row.pct.trim()) continue;
      if (!row.label.trim()) { setError("Each grade boundary needs a label."); return; }
      const pctNum = parseFloat(row.pct);
      if (isNaN(pctNum) || pctNum < 0 || pctNum > 100) { setError(`Boundary "${row.label}" needs a valid percentage (0–100).`); return; }
      grade_boundaries[row.label.trim()] = pctNum;
    }

    setError(null);
    setLoading(true);

    try {
      interface TestResponse { data: Test }
      const url = existing
        ? `/api/v1/classes/${classId}/tests/${existing.id}`
        : `/api/v1/classes/${classId}/tests`;
      const result = await apiFetch<TestResponse>(url, {
        method: existing ? "PUT" : "POST",
        body: {
          name: name.trim(),
          topics,
          max_mark: markNum,
          grade_boundaries,
        },
      });
      onSaved(result.data);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to save test.");
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 my-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">{existing ? "Edit Test" : "New Test"}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
            {/* Name */}
            <div>
              <label htmlFor="test-name" className="block text-sm font-medium text-gray-700 mb-1">
                Name <span className="text-red-500">*</span>
              </label>
              <input
                id="test-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="End of Unit Test"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
              />
            </div>

            {/* Total marks */}
            <div>
              <label htmlFor="test-max-mark" className="block text-sm font-medium text-gray-700 mb-1">
                Total marks <span className="text-red-500">*</span>
              </label>
              <input
                id="test-max-mark"
                type="number"
                min={1}
                step={1}
                value={maxMark}
                onChange={(e) => setMaxMark(e.target.value)}
                placeholder="100"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
              />
            </div>

            {/* Topics */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Topics covered</label>
              <TagInput tags={topics} onChange={setTopics} placeholder="Type a topic and press Enter" />
            </div>

            {/* Grade boundaries */}
            <div>
              <button
                type="button"
                onClick={() => setShowBoundaries((v) => !v)}
                className="flex items-center gap-1.5 text-sm font-medium text-gray-700 hover:text-gray-900 transition"
              >
                <svg
                  className={`w-4 h-4 transition-transform ${showBoundaries ? "rotate-90" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                Grade boundaries
                <span className="text-xs text-gray-400 font-normal ml-1">(optional)</span>
              </button>

              {showBoundaries && (
                <div className="mt-3 space-y-2">
                  {/* Preset pills */}
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-gray-400">Presets:</span>
                    <button
                      type="button"
                      onClick={() => setBoundaries([
                        { label: "A", pct: "90" },
                        { label: "B", pct: "80" },
                        { label: "C", pct: "70" },
                        { label: "D", pct: "60" },
                        { label: "E", pct: "50" },
                        { label: "F", pct: "0" },
                      ])}
                      className="rounded-full border border-gray-300 px-3 py-1 text-sm text-gray-600 hover:border-indigo-400 hover:text-indigo-600 transition"
                    >
                      A–F
                    </button>
                    <button
                      type="button"
                      onClick={() => setBoundaries([
                        { label: "9", pct: "90" },
                        { label: "8", pct: "80" },
                        { label: "7", pct: "70" },
                        { label: "6", pct: "60" },
                        { label: "5", pct: "50" },
                        { label: "4", pct: "40" },
                        { label: "3", pct: "30" },
                        { label: "2", pct: "20" },
                        { label: "1", pct: "0" },
                      ])}
                      className="rounded-full border border-gray-300 px-3 py-1 text-sm text-gray-600 hover:border-indigo-400 hover:text-indigo-600 transition"
                    >
                      1–9
                    </button>
                  </div>
                  {boundaries.length === 0 && (
                    <p className="text-xs text-gray-400">No boundaries yet. Add one below.</p>
                  )}
                  {boundaries.map((row, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={row.label}
                        onChange={(e) => updateBoundary(idx, "label", e.target.value)}
                        placeholder="Grade (e.g. A)"
                        className="w-28 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
                      />
                      <span className="text-sm text-gray-400">&ge;</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={row.pct}
                        onChange={(e) => updateBoundary(idx, "pct", e.target.value)}
                        placeholder="Min %"
                        className="w-24 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
                      />
                      <span className="text-xs text-gray-400">%</span>
                      <button
                        type="button"
                        onClick={() => removeBoundary(idx)}
                        className="text-gray-400 hover:text-red-500 transition ml-auto"
                        aria-label="Remove boundary"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={addBoundary}
                    className="mt-1 text-xs font-medium text-indigo-600 hover:text-indigo-800 transition"
                  >
                    + Add boundary
                  </button>
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="mx-6 mb-2 rounded-md bg-red-50 border border-red-200 px-4 py-2.5 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim() || !maxMark}
              className="px-5 py-2 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {loading ? "Saving..." : existing ? "Save Changes" : "Create Test"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Duplicate Test Modal ──────────────────────────────────────────────────────

function DuplicateTestModal({
  classId,
  test,
  onClose,
  onDuplicated,
}: {
  classId: string;
  test: Test;
  onClose: () => void;
  onDuplicated: (newTest: Test, targetClassId: string) => void;
}) {
  const [classes, setClasses] = useState<ClassListItem[]>([]);
  const [loadingClasses, setLoadingClasses] = useState(true);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        interface ClassListResponse { data: ClassListItem[] }
        const result = await apiFetch<ClassListResponse>("/api/v1/classes");
        if (!cancelled) {
          setClasses(result.data.filter((c) => !c.archived));
        }
      } catch {
        if (!cancelled) setError("Failed to load classes.");
      } finally {
        if (!cancelled) setLoadingClasses(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  async function handleDuplicate() {
    if (!selectedClassId) return;
    setDuplicating(true);
    setError(null);
    try {
      interface CopyResponse { data: Test }
      const result = await apiFetch<CopyResponse>(`/api/v1/classes/${classId}/tests/copy`, {
        method: "POST",
        body: { testId: test.id, targetClassId: selectedClassId },
      });
      onDuplicated(result.data, selectedClassId);
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Failed to duplicate test.");
      setDuplicating(false);
    }
  }

  const selectedClass = classes.find((c) => c.id === selectedClassId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Duplicate Test</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-gray-600">
            Duplicating <span className="font-medium">&ldquo;{test.name}&rdquo;</span>. Choose a destination class:
          </p>

          {loadingClasses ? (
            <div className="space-y-2 animate-pulse">
              {[1, 2, 3].map((n) => <div key={n} className="h-12 bg-gray-100 rounded-lg" />)}
            </div>
          ) : (
            <div className="space-y-1.5 max-h-60 overflow-y-auto">
              {classes.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedClassId(c.id)}
                  className={`w-full text-left px-4 py-3 rounded-lg border transition ${
                    selectedClassId === c.id
                      ? "border-indigo-500 bg-indigo-50"
                      : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-900">{c.name}</span>
                    {c.id === classId && (
                      <span className="text-xs text-gray-400">(this class)</span>
                    )}
                  </div>
                  {(c.year_group || c.subject) && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      {[c.year_group && `Year ${c.year_group}`, c.subject].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )}

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDuplicate}
            disabled={!selectedClassId || duplicating}
            className="px-5 py-2 rounded-md bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {duplicating
              ? "Duplicating..."
              : selectedClass
              ? `Duplicate to ${selectedClass.name}`
              : "Duplicate"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tests card ────────────────────────────────────────────────────────────────

function TestsCard({ classId }: { classId: string }) {
  const [tests, setTests] = useState<Test[]>([]);
  const [loading, setLoading] = useState(true);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [showAddEdit, setShowAddEdit] = useState(false);
  const [editingTest, setEditingTest] = useState<Test | null>(null);
  const [duplicatingTest, setDuplicatingTest] = useState<Test | null>(null);
  const [deletingTestId, setDeletingTestId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        interface TestListResponse { data: Test[] }
        const result = await apiFetch<TestListResponse>(`/api/v1/classes/${classId}/tests`);
        if (!cancelled) setTests(result.data);
      } catch {
        // Non-fatal
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [classId]);

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  function handleSaved(test: Test) {
    setTests((prev) => {
      const idx = prev.findIndex((t) => t.id === test.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = test;
        return next;
      }
      return [test, ...prev];
    });
    setShowAddEdit(false);
    setEditingTest(null);
  }

  function handleDuplicated(newTest: Test, targetClassId: string) {
    if (targetClassId === classId) {
      setTests((prev) => [newTest, ...prev]);
    }
    setDuplicatingTest(null);
    showToast(`"${newTest.name}" duplicated successfully.`);
  }

  async function handleDelete(testId: string) {
    try {
      await apiFetch(`/api/v1/classes/${classId}/tests/${testId}`, { method: "DELETE" });
      setTests((prev) => prev.filter((t) => t.id !== testId));
    } catch {
      // Silently ignore for now
    } finally {
      setDeletingTestId(null);
    }
  }

  const hasBoundaries = (t: Test) => Object.keys(t.grade_boundaries).length > 0;

  return (
    <>
      {/* Modals */}
      {(showAddEdit || editingTest) && (
        <TestModal
          classId={classId}
          existing={editingTest}
          onClose={() => { setShowAddEdit(false); setEditingTest(null); }}
          onSaved={handleSaved}
        />
      )}
      {duplicatingTest && (
        <DuplicateTestModal
          classId={classId}
          test={duplicatingTest}
          onClose={() => setDuplicatingTest(null)}
          onDuplicated={handleDuplicated}
        />
      )}
      {deletingTestId && (
        <ConfirmDialog
          message="Delete this test? All student results for this test will also be deleted. This cannot be undone."
          confirmLabel="Delete Test"
          onConfirm={() => handleDelete(deletingTestId)}
          onCancel={() => setDeletingTestId(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm px-4 py-2.5 rounded-lg shadow-lg">
          {toast}
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Tests</h2>
          <button
            onClick={() => { setEditingTest(null); setShowAddEdit(true); }}
            className="px-3 py-1.5 rounded-md bg-indigo-600 text-xs font-semibold text-white hover:bg-indigo-700 transition"
          >
            + Add Test
          </button>
        </div>

        {loading ? (
          <div className="px-6 py-4 space-y-3 animate-pulse">
            {[1, 2].map((n) => <div key={n} className="h-10 bg-gray-100 rounded" />)}
          </div>
        ) : tests.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-sm text-gray-400 mb-3">No tests yet. Add your first test.</p>
            <button
              onClick={() => { setEditingTest(null); setShowAddEdit(true); }}
              className="text-sm text-indigo-600 hover:text-indigo-700 font-medium transition"
            >
              + Add Test
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-50" ref={menuRef}>
            {tests.map((test) => (
              <div key={test.id} className="flex items-center justify-between px-6 py-3.5 group hover:bg-gray-50 transition">
                <Link href={`/classes/${classId}/tests/${test.id}`} className="min-w-0 flex-1 mr-4">
                  <span className="font-medium text-gray-900 text-sm hover:text-indigo-600 transition">{test.name}</span>
                  <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-400">
                    <span>{test.max_mark} marks</span>
                    <span
                      title={hasBoundaries(test) ? Object.entries(test.grade_boundaries).map(([g, p]) => `${g}: ${p}%`).join(", ") : "No grade boundaries set"}
                    >
                      {hasBoundaries(test) ? "✓ grades" : "— grades"}
                    </span>
                    <span>{test.topics.length} topic{test.topics.length !== 1 ? "s" : ""}</span>
                  </div>
                </Link>

                {/* Three-dot menu */}
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setOpenMenuId(openMenuId === test.id ? null : test.id)}
                    className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition opacity-0 group-hover:opacity-100 focus:opacity-100"
                    aria-label="Test options"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <circle cx="12" cy="5" r="1.5" />
                      <circle cx="12" cy="12" r="1.5" />
                      <circle cx="12" cy="19" r="1.5" />
                    </svg>
                  </button>

                  {openMenuId === test.id && (
                    <div className="absolute right-0 top-8 z-20 w-36 bg-white rounded-lg border border-gray-200 shadow-lg py-1">
                      <button
                        type="button"
                        onClick={() => { setEditingTest(test); setShowAddEdit(false); setOpenMenuId(null); }}
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => { setDuplicatingTest(test); setOpenMenuId(null); }}
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition"
                      >
                        Duplicate
                      </button>
                      <button
                        type="button"
                        onClick={() => { setDeletingTestId(test.id); setOpenMenuId(null); }}
                        className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}

          </div>
        )}
      </div>
    </>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function ClassDetailSkeleton() {
  return (
    <div className="max-w-5xl mx-auto animate-pulse space-y-6">
      <div className="h-4 bg-gray-200 rounded w-48 mb-2" />
      <div className="h-8 bg-gray-200 rounded w-1/3" />
      <div className="h-4 bg-gray-100 rounded w-1/4" />
      <div className="bg-white rounded-lg border border-gray-200 p-0">
        <div className="border-b border-gray-200 px-6 py-3 flex gap-6">
          <div className="h-5 bg-gray-200 rounded w-24" />
          <div className="h-5 bg-gray-200 rounded w-20" />
          <div className="h-5 bg-gray-200 rounded w-28" />
        </div>
        <div className="p-6 space-y-3">
          <div className="h-5 bg-gray-200 rounded w-1/4" />
          {[1, 2, 3].map((n) => <div key={n} className="h-10 bg-gray-100 rounded" />)}
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

interface ClassDetailResponse {
  data: ClassDetail;
}

export default function ClassDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = typeof params.id === "string" ? params.id : (params.id?.[0] ?? "");

  const [cls, setCls] = useState<ClassDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [showAddRow, setShowAddRow] = useState(false);
  const [editingStudentId, setEditingStudentId] = useState<string | null>(null);
  const [deletingStudentId, setDeletingStudentId] = useState<string | null>(null);
  const [showBulkAdd, setShowBulkAdd] = useState(false);
  const [showCreateSession, setShowCreateSession] = useState(false);
  const [showEditClass, setShowEditClass] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Student table sort state
  const [sortField, setSortField] = useState<'first_name' | 'last_name' | 'student_ref_id' | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Tab state
  type TabKey = 'sessions' | 'students' | 'tests';
  const [activeTab, setActiveTab] = useState<TabKey>('sessions');

  // Student search state
  const [studentSearch, setStudentSearch] = useState('');
  // Tests module is not available in session-only mode
  const { isStatelessMode } = useAuth();

  function handleSortHeader(field: 'first_name' | 'last_name' | 'student_ref_id') {
    if (sortField !== field) {
      setSortField(field);
      setSortDir('asc');
    } else if (sortDir === 'asc') {
      setSortDir('desc');
    } else {
      // third click — reset
      setSortField(null);
      setSortDir('asc');
    }
  }

  const sortedStudents = useMemo(() => {
    let students = cls?.students ?? [];
    if (studentSearch.trim()) {
      const q = studentSearch.toLowerCase();
      students = students.filter((s) =>
        s.first_name.toLowerCase().includes(q) ||
        (s.last_name ?? '').toLowerCase().includes(q)
      );
    }
    if (!sortField) return students;
    return [...students].sort((a, b) => {
      const aVal = a[sortField] ?? '';
      const bVal = b[sortField] ?? '';
      const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [cls?.students, sortField, sortDir, studentSearch]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load() {
      try {
        const result = await apiFetch<ClassDetailResponse>(`/api/v1/classes/${id}`);
        if (!cancelled) setCls(result.data);
      } catch (err) {
        if (!cancelled) {
          if (err instanceof APIError && err.status === 404) {
            router.replace("/dashboard");
          } else {
            setError(err instanceof APIError ? err.message : "Failed to load class.");
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [id, router]);

  function handleStudentAdded(student: Student) {
    setCls((prev) => prev ? { ...prev, students: [...prev.students, student].sort((a, b) => a.first_name.localeCompare(b.first_name)) } : prev);
    setShowAddRow(false);
  }

  function handleStudentSaved(updated: Student) {
    setCls((prev) => prev ? {
      ...prev,
      students: prev.students.map((s) => s.id === updated.id ? updated : s),
    } : prev);
    setEditingStudentId(null);
  }

  function handleBulkAdded(students: Student[]) {
    // API returns all students in the class (already sorted), replace the list wholesale
    setCls((prev) => prev ? { ...prev, students } : prev);
    setShowBulkAdd(false);
  }

  function handleSessionCreated(session: Session) {
    setCls((prev) => prev ? { ...prev, sessions: [session, ...prev.sessions] } : prev);
    setShowCreateSession(false);
    router.push(`/classes/${id}/sessions/${session.id}`);
  }

  function handleClassSaved(updates: Partial<ClassDetail>) {
    setCls((prev) => prev ? { ...prev, ...updates } : prev);
    setShowEditClass(false);
  }

  async function handleDeleteStudent(studentId: string) {
    setDeleteError(null);
    try {
      await apiFetch(`/api/v1/students/${studentId}`, { method: "DELETE" });
      setCls((prev) => prev ? { ...prev, students: prev.students.filter((s) => s.id !== studentId) } : prev);
    } catch (err) {
      if (err instanceof APIError && err.code === "STUDENT_HAS_FINAL_REPORTS") {
        setDeleteError("Cannot remove student — they have final reports. Delete or archive reports first.");
      } else {
        setDeleteError(err instanceof APIError ? err.message : "Failed to remove student.");
      }
    } finally {
      setDeletingStudentId(null);
    }
  }

  async function handleArchive() {
    setArchiving(true);
    try {
      await apiFetch(`/api/v1/classes/${id}/archive`, { method: "POST" });
      router.push("/dashboard");
    } catch {
      setArchiving(false);
      setShowArchiveConfirm(false);
    }
  }

  if (loading) return <ClassDetailSkeleton />;

  if (error) {
    return (
      <div className="max-w-5xl mx-auto">
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  if (!cls) return null;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Modals */}
      {showCreateSession && (
        <CreateSessionModal
          classId={id}
          onClose={() => setShowCreateSession(false)}
          onCreated={handleSessionCreated}
        />
      )}
      {showBulkAdd && (
        <BulkAddModal
          classId={id}
          onClose={() => setShowBulkAdd(false)}
          onAdded={handleBulkAdded}
        />
      )}
      {showEditClass && (
        <EditClassModal
          cls={cls}
          onClose={() => setShowEditClass(false)}
          onSaved={handleClassSaved}
        />
      )}
      {showArchiveConfirm && (
        <ConfirmDialog
          message={`Archive "${cls.name}"? It will be hidden from your dashboard. You can view it via the "Show Archived" filter.`}
          confirmLabel={archiving ? "Archiving..." : "Archive Class"}
          onConfirm={handleArchive}
          onCancel={() => setShowArchiveConfirm(false)}
        />
      )}
      {deletingStudentId && (
        <ConfirmDialog
          message="Remove this student? This action cannot be undone. Students with final reports cannot be removed."
          confirmLabel="Remove"
          onConfirm={() => handleDeleteStudent(deletingStudentId)}
          onCancel={() => setDeletingStudentId(null)}
        />
      )}

      {/* Breadcrumb + header */}
      <div>
        <nav className="flex items-center gap-1.5 text-sm text-gray-500 mb-2">
          <Link href="/dashboard" className="hover:text-indigo-600 transition">Dashboard</Link>
          <span>/</span>
          <span className="text-gray-800 font-medium truncate">{cls.name}</span>
        </nav>

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900">{cls.name}</h1>
              <span className="text-sm bg-gray-100 text-gray-600 px-2.5 py-0.5 rounded-full font-medium">
                {cls.students.length} student{cls.students.length !== 1 ? "s" : ""}
              </span>
              {cls.archived && (
                <span className="text-xs bg-yellow-100 text-yellow-700 px-2.5 py-0.5 rounded-full font-medium">
                  Archived
                </span>
              )}
            </div>
            {(cls.year_group || cls.subject) && (
              <p className="mt-1 text-sm text-gray-500">
                {[cls.year_group && `Year ${cls.year_group}`, cls.subject].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowEditClass(true)}
              className="px-3 py-1.5 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
            >
              Edit
            </button>
            {!cls.archived && (
              <button
                onClick={() => setShowArchiveConfirm(true)}
                className="px-3 py-1.5 rounded-md border border-red-200 text-sm font-medium text-red-600 hover:bg-red-50 transition"
              >
                Archive Class
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Delete error banner */}
      {deleteError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 flex items-center justify-between">
          <span>{deleteError}</span>
          <button onClick={() => setDeleteError(null)} className="text-red-400 hover:text-red-600 ml-4">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Tab navigation */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="border-b border-gray-200">
          <nav className="flex gap-0" aria-label="Tabs">
            {([
              { key: 'sessions' as TabKey, label: 'Report Sessions' },
              { key: 'students' as TabKey, label: 'Students' },
              // Tests module is not available in session-only mode
              ...(isStatelessMode ? [] : [{ key: 'tests' as TabKey, label: 'Tests' }]),
            ]).map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-6 py-3.5 text-sm font-medium border-b-2 transition whitespace-nowrap ${
                  activeTab === tab.key
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Tab panels */}
        {activeTab === 'students' && (
          <div className="p-0">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
                Students
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setShowBulkAdd(true); setShowAddRow(false); }}
                  className="px-3 py-1.5 rounded-md border border-gray-300 text-xs font-medium text-gray-700 hover:bg-gray-50 transition"
                >
                  Bulk Add
                </button>
                <button
                  onClick={() => { setShowAddRow(true); setShowBulkAdd(false); }}
                  className="px-3 py-1.5 rounded-md bg-indigo-600 text-xs font-semibold text-white hover:bg-indigo-700 transition"
                >
                  + Add Student
                </button>
              </div>
            </div>

            {/* Search bar */}
            <div className="px-6 py-3 border-b border-gray-100">
              <div className="relative max-w-xs">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="11" cy="11" r="8" />
                  <path strokeLinecap="round" d="m21 21-4.35-4.35" />
                </svg>
                <input
                  type="text"
                  value={studentSearch}
                  onChange={(e) => setStudentSearch(e.target.value)}
                  placeholder="Search students…"
                  className="w-full pl-9 pr-3 py-1.5 rounded-md border border-gray-300 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
                />
              </div>
            </div>

            {cls.students.length === 0 && !showAddRow ? (
              <div className="px-6 py-10 text-center">
                <p className="text-sm text-gray-400 mb-3">No students yet.</p>
                <button
                  onClick={() => setShowAddRow(true)}
                  className="text-sm text-indigo-600 hover:text-indigo-700 font-medium transition"
                >
                  Add your first student
                </button>
              </div>
            ) : (
              <div className="max-h-[600px] overflow-y-auto overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-white">
                    <tr className="border-b border-gray-100 text-left shadow-sm">
                      {(['first_name', 'last_name', 'student_ref_id'] as const).map((field, i) => {
                        const labels: Record<string, string> = { first_name: 'First Name', last_name: 'Last Name', student_ref_id: 'Ref ID' };
                        const active = sortField === field;
                        const icon = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕';
                        return (
                          <th
                            key={field}
                            onClick={() => handleSortHeader(field)}
                            className={`px-4 py-3 text-xs font-semibold uppercase tracking-wide cursor-pointer select-none transition ${active ? 'text-indigo-600' : 'text-gray-500 hover:text-gray-700'}`}
                            style={i === 0 ? {} : undefined}
                          >
                            {labels[field]}
                            <span className={active ? 'text-indigo-500' : 'text-gray-300'}>{icon}</span>
                          </th>
                        );
                      })}
                      <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Gender</th>
                      <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {sortedStudents.map((student) =>
                      editingStudentId === student.id ? (
                        <EditStudentRow
                          key={student.id}
                          student={student}
                          onSaved={handleStudentSaved}
                          onCancel={() => setEditingStudentId(null)}
                        />
                      ) : (
                        <tr key={student.id} className="hover:bg-gray-50 transition group">
                          <td className="px-4 py-3 font-medium text-gray-900">{student.first_name}</td>
                          <td className="px-4 py-3 text-gray-600">{student.last_name ?? <span className="text-gray-300">—</span>}</td>
                          <td className="px-4 py-3 text-gray-500 font-mono text-xs">{student.student_ref_id ?? <span className="text-gray-300">—</span>}</td>
                          <td className="px-4 py-3 text-gray-500 capitalize">{student.gender ?? <span className="text-gray-300">—</span>}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition">
                              <button
                                onClick={() => setEditingStudentId(student.id)}
                                className="text-xs text-indigo-600 hover:text-indigo-800 font-medium transition"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => setDeletingStudentId(student.id)}
                                className="text-xs text-red-500 hover:text-red-700 font-medium transition"
                              >
                                Remove
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    )}
                    {showAddRow && (
                      <AddStudentRow
                        classId={id}
                        onAdded={handleStudentAdded}
                        onCancel={() => setShowAddRow(false)}
                      />
                    )}
                    {sortedStudents.length === 0 && studentSearch.trim() && (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">
                          No students match &ldquo;{studentSearch}&rdquo;
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'tests' && (
          <div className="p-0">
            <TestsCard classId={id} />
          </div>
        )}

        {activeTab === 'sessions' && (
          <div className="p-0">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
                Report Sessions
              </h2>
              <button
                onClick={() => setShowCreateSession(true)}
                className="px-3 py-1.5 rounded-md bg-indigo-600 text-xs font-semibold text-white hover:bg-indigo-700 transition"
              >
                + New Session
              </button>
            </div>

            {cls.sessions.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <p className="text-sm text-gray-400 mb-3">No report sessions yet.</p>
                <button
                  onClick={() => setShowCreateSession(true)}
                  className="text-sm text-indigo-600 hover:text-indigo-700 font-medium transition"
                >
                  Create your first session
                </button>
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {cls.sessions.map((session) => (
                  <Link
                    key={session.id}
                    href={`/classes/${id}/sessions/${session.id}`}
                    className="flex items-start justify-between px-6 py-4 hover:bg-gray-50 transition group"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-gray-900 group-hover:text-indigo-700 transition truncate">
                          {session.name}
                        </span>
                        <StatusBadge status={session.status} />
                      </div>
                      {session.topics_covered.length > 0 && (
                        <p className="text-xs text-gray-400 truncate">
                          {session.topics_covered.slice(0, 4).join(", ")}
                          {session.topics_covered.length > 4 && ` +${session.topics_covered.length - 4} more`}
                        </p>
                      )}
                      <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                        <span>{session._count?.disciplines ?? 0} discipline{session._count?.disciplines !== 1 ? "s" : ""}</span>
                        <span>{session._count?.reports ?? 0} report{session._count?.reports !== 1 ? "s" : ""}</span>
                        <span>{new Date(session.created_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <svg className="w-4 h-4 text-gray-300 group-hover:text-indigo-400 mt-1 shrink-0 transition" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
