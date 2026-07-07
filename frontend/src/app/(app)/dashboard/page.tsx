"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch, APIError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClassCard {
  id: string;
  name: string;
  year_group: string | null;
  subject: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
  _count: {
    students: number;
    sessions: number;
  };
}

interface ClassesResponse {
  data: ClassCard[];
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function ClassCardSkeleton() {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 animate-pulse">
      <div className="h-5 bg-gray-200 rounded w-2/3 mb-3" />
      <div className="h-4 bg-gray-100 rounded w-1/2 mb-2" />
      <div className="h-4 bg-gray-100 rounded w-1/3 mb-4" />
      <div className="border-t border-gray-100 pt-3 flex gap-4">
        <div className="h-3 bg-gray-100 rounded w-16" />
        <div className="h-3 bg-gray-100 rounded w-16" />
      </div>
    </div>
  );
}

// ── Class card ────────────────────────────────────────────────────────────────

function ClassCardItem({ cls }: { cls: ClassCard }) {
  // Use updated_at as proxy for last activity
  const lastActivity = new Date(cls.updated_at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <Link
      href={`/classes/${cls.id}`}
      className={`bg-white rounded-lg shadow-sm border p-6 hover:shadow-md transition group flex flex-col ${
        cls.archived
          ? "border-gray-200 opacity-60 hover:opacity-80"
          : "border-gray-200 hover:border-indigo-300"
      }`}
    >
      <div className="flex items-start justify-between mb-1">
        <h2 className={`text-base font-semibold truncate ${cls.archived ? "text-gray-500" : "text-gray-900 group-hover:text-indigo-700"} transition`}>
          {cls.name}
        </h2>
        {cls.archived && (
          <span className="ml-2 shrink-0 inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
            Archived
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500 mb-3">
        {cls.year_group && <span>Year {cls.year_group}</span>}
        {cls.subject && <span>{cls.subject}</span>}
      </div>

      <div className="mt-auto flex items-center justify-between text-xs text-gray-400 border-t border-gray-100 pt-3">
        <div className="flex items-center gap-4">
          <span>
            <span className="font-semibold text-gray-700">{cls._count.students}</span>{" "}
            student{cls._count.students !== 1 ? "s" : ""}
          </span>
          <span>
            <span className="font-semibold text-gray-700">{cls._count.sessions}</span>{" "}
            session{cls._count.sessions !== 1 ? "s" : ""}
          </span>
        </div>
        <span className="hidden sm:block">{lastActivity}</span>
      </div>
    </Link>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const { isStatelessMode } = useAuth();
  const [classes, setClasses] = useState<ClassCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [seeding, setSeeding] = useState(false);

  async function handleLoadSample() {
    setSeeding(true);
    try {
      const { seedSampleClass } = await import("@/lib/stateless/sample-data");
      const classId = seedSampleClass();
      router.push(`/classes/${classId}`);
    } catch {
      setError("Failed to create the sample class.");
      setSeeding(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadClasses() {
      try {
        const result = await apiFetch<ClassesResponse>("/api/v1/classes");
        if (!cancelled) {
          setClasses(result.data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof APIError ? err.message : "Failed to load classes.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadClasses();
    return () => { cancelled = true; };
  }, []);

  const activeClasses = classes.filter((c) => !c.archived);
  const archivedClasses = classes.filter((c) => c.archived);
  const visibleClasses = showArchived ? classes : activeClasses;

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Classes</h1>
          <p className="mt-1 text-sm text-gray-500">
            {activeClasses.length} active class{activeClasses.length !== 1 ? "es" : ""}
            {archivedClasses.length > 0 && ` · ${archivedClasses.length} archived`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {archivedClasses.length > 0 && (
            <button
              onClick={() => setShowArchived((v) => !v)}
              className={`text-sm font-medium transition px-3 py-1.5 rounded-md border ${
                showArchived
                  ? "border-indigo-300 text-indigo-700 bg-indigo-50"
                  : "border-gray-300 text-gray-600 hover:bg-gray-50"
              }`}
            >
              {showArchived ? "Hide Archived" : "Show Archived"}
            </button>
          )}
          <Link
            href="/classes/new"
            className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 transition"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            New Class
          </Link>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 mb-6">
          {error}
        </div>
      )}

      {/* Loading skeletons */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((n) => <ClassCardSkeleton key={n} />)}
        </div>
      )}

      {/* Empty state — no classes at all */}
      {!loading && !error && classes.length === 0 && (
        <div className="text-center py-16 bg-white rounded-lg border border-gray-200 shadow-sm">
          <svg
            className="mx-auto w-12 h-12 text-gray-300 mb-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
            />
          </svg>
          <p className="text-gray-500 text-sm mb-4">No classes yet. Create your first class to get started.</p>
          <div className="flex items-center justify-center gap-3">
            <Link
              href="/classes/new"
              className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition"
            >
              Create a class
            </Link>
            {isStatelessMode && (
              <button
                onClick={handleLoadSample}
                disabled={seeding}
                className="inline-flex items-center gap-2 rounded-md border border-indigo-600 px-4 py-2 text-sm font-semibold text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 transition"
              >
                {seeding ? "Loading..." : "Load sample class"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Empty state — all classes are archived and showArchived is false */}
      {!loading && !error && classes.length > 0 && visibleClasses.length === 0 && (
        <div className="text-center py-16 bg-white rounded-lg border border-gray-200 shadow-sm">
          <p className="text-gray-500 text-sm mb-3">All classes are archived.</p>
          <button
            onClick={() => setShowArchived(true)}
            className="text-sm text-indigo-600 hover:text-indigo-700 font-medium transition"
          >
            Show archived classes
          </button>
        </div>
      )}

      {/* Class cards grid */}
      {!loading && visibleClasses.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleClasses.map((cls) => (
            <ClassCardItem key={cls.id} cls={cls} />
          ))}
        </div>
      )}
    </div>
  );
}
