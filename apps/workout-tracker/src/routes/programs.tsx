import {
  createFileRoute,
  Link,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useState } from "react";
import { useIsMobile } from "@/client/hooks/use-mobile";
import {
  useAllProgramsWithWorkouts,
  type ProgramWithWorkouts,
} from "@/client/hooks/useProgramData";
import { TabBar } from "@/client/components/TabBar";
import { programTemplates } from "@/data/program-templates";
import {
  createCustomProgram,
  createCustomProgramParams,
} from "@/client/actions/createCustomProgram";
import { Button } from "@/client/components/ui/button";
import { capitalize } from "@/client/lib/utils";

export const Route = createFileRoute("/programs")({
  component: ProgramsListPage,
});

function ProgramsListPage() {
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();
  const [isCreating, setIsCreating] = useState(false);

  const { programs: userPrograms } = useAllProgramsWithWorkouts();

  const handleCreateProgram = async () => {
    if (isCreating) return;
    setIsCreating(true);

    try {
      const params = createCustomProgramParams();
      await createCustomProgram(params);

      navigate({
        to: "/programs/$programId",
        params: { programId: params.programId },
        search: { newProgramSource: "custom" },
      });
    } catch (error) {
      console.error("Failed to create program:", error);
      setIsCreating(false);
    }
  };

  // Sort user programs with active program first
  const sortedPrograms = [...userPrograms].sort((a, b) => {
    if (a.isActive && !b.isActive) return -1;
    if (!a.isActive && b.isActive) return 1;
    return 0;
  });

  return (
    <>
      <div className="page-container">
        <div className="px-4 pt-6 pb-24">
          {/* Page Header */}
          <div className="page-header mb-6 px-0">
            <div>
              <h1 className="page-title">Programs</h1>
              <p className="text-base-content/70 mt-1">
                Explore programs as starting templates for your training
              </p>
            </div>
          </div>

          {/* My Programs Section */}
          <section className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-base-content">
                My Programs
              </h2>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCreateProgram}
                disabled={isCreating}
              >
                Create
              </Button>
            </div>
            {sortedPrograms.length === 0 ? (
              <div className="rounded-xl border border-dashed border-base-content/20 p-6 text-center">
                <p className="text-base-content/70">
                  You haven't started any programs yet. Pick a template below to
                  get started!
                </p>
                <div className="text-base-content/40 text-2xl mt-2">↓</div>
              </div>
            ) : (
              <div className="space-y-4">
                {sortedPrograms.map((program) => (
                  <ProgramCard key={program.id} program={program} />
                ))}
              </div>
            )}
          </section>

          {/* Program Templates Section */}
          <section>
            <h2 className="text-lg font-semibold text-base-content mb-4">
              Program Templates
            </h2>
            <div className="space-y-4">
              {programTemplates.map((template) => (
                <TemplateCard key={template.id} template={template} />
              ))}
            </div>
          </section>
        </div>
      </div>

      {isMobile && <TabBar currentPath={location.pathname} />}
    </>
  );
}

function ProgramCard({ program }: { program: ProgramWithWorkouts }) {
  return (
    <Link
      to="/programs/$programId"
      params={{ programId: program.id }}
      className="block"
    >
      <div className="program-card">
        <div className="flex items-start justify-between gap-4 mb-3">
          <h3 className="font-bold text-lg text-base-content">
            {program.name}
          </h3>
          {program.isActive && <span className="badge-active">Active</span>}
        </div>
        {program.description && (
          <p className="text-sm text-base-content/70 mb-4">
            {program.description}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <span className="tag-pill">{program.workouts.length} days/week</span>
          {program.difficulty !== "n/a" && (
            <span className="tag-pill">{capitalize(program.difficulty)}</span>
          )}
        </div>
      </div>
    </Link>
  );
}

function TemplateCard({
  template,
}: {
  template: (typeof programTemplates)[0];
}) {
  return (
    <Link
      to="/templates/$templateId"
      params={{ templateId: template.id }}
      className="block"
    >
      <div className="program-card">
        <h3 className="font-bold text-lg text-base-content mb-3">
          {template.name}
        </h3>
        <p className="text-sm text-base-content/70 mb-4">
          {template.description}
        </p>
        <div className="flex flex-wrap gap-2">
          <span className="tag-pill">{template.workouts.length} days/week</span>
          <span className="tag-pill">{capitalize(template.difficulty)}</span>
        </div>
      </div>
    </Link>
  );
}
