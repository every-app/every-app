import {
  createFileRoute,
  Link,
  useNavigate,
  useLocation,
} from "@tanstack/react-router";
import { useState } from "react";
import { useIsMobile } from "@/client/hooks/use-mobile";
import {
  useAllProgramsWithWorkouts,
  type ProgramWithWorkouts,
} from "@/client/hooks/useProgramData";
import { TabBar } from "@/client/components/TabBar";
import { programTemplates } from "@/data/program-templates";
import { EmptyState } from "@/client/components/ui/empty-state";
import { Dumbbell } from "lucide-react";
import {
  startProgramFromTemplate,
  createStartProgramParams,
} from "@/client/actions/startProgramFromTemplate";

export const Route = createFileRoute("/programs")({
  component: ProgramsListPage,
});

function ProgramsListPage() {
  const isMobile = useIsMobile();
  const location = useLocation();

  const { programs: userPrograms } = useAllProgramsWithWorkouts();

  // Templates not yet started
  const startedTemplateIds = new Set(
    userPrograms.map((p) => p.templateId).filter(Boolean),
  );
  const availableTemplates = programTemplates.filter(
    (t) => !startedTemplateIds.has(t.id),
  );

  // Combine all programs (user programs + available templates), with active program first
  const sortedPrograms = [...userPrograms].sort((a, b) => {
    if (a.isActive && !b.isActive) return -1;
    if (!a.isActive && b.isActive) return 1;
    return 0;
  });

  const allItems = [
    ...sortedPrograms.map((p) => ({ type: "program" as const, data: p })),
    ...availableTemplates.map((t) => ({
      type: "template" as const,
      data: t,
    })),
  ];

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

          {/* Programs List */}
          {allItems.length === 0 ? (
            <EmptyState
              icon={<Dumbbell className="h-12 w-12 mx-auto" />}
              title="No Programs"
              description="Get started by creating your first program."
            />
          ) : (
            <div className="space-y-4">
              {allItems.map((item) =>
                item.type === "program" ? (
                  <ProgramCard key={item.data.id} program={item.data} />
                ) : (
                  <TemplateCard key={item.data.id} template={item.data} />
                ),
              )}
            </div>
          )}
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
        <p className="text-sm text-base-content/70 mb-4">
          {program.description}
        </p>
        <div className="flex flex-wrap gap-2">
          <span className="tag-pill">{program.workouts.length} days/week</span>
          <span className="tag-pill">{capitalize(program.difficulty)}</span>
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
  const navigate = useNavigate();
  const [isCreating, setIsCreating] = useState(false);

  const handleStartProgram = async () => {
    if (isCreating) return;
    setIsCreating(true);

    try {
      // Create params with pre-generated IDs
      const params = createStartProgramParams(template);

      // Use the atomic action
      await startProgramFromTemplate(params);

      // Navigate to the new program
      navigate({
        to: "/programs/$programId",
        params: { programId: params.programId },
      });
    } catch (error) {
      console.error("Failed to create program:", error);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div
      className={`program-card ${isCreating ? "opacity-50 pointer-events-none" : ""}`}
      onClick={handleStartProgram}
    >
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
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
