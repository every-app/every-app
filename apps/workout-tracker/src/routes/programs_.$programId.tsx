import {
  createFileRoute,
  Link,
  useNavigate,
  useLocation,
} from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { useIsMobile } from "@/client/hooks/use-mobile";
import {
  useProgramById,
  useAllProgramsWithWorkouts,
} from "@/client/hooks/useProgramData";
import { TabBar } from "@/client/components/TabBar";
import { programsCollection } from "@/client/tanstack-db";
import { Button } from "@/client/components/ui/button";
import { WorkoutCard } from "@/client/components/WorkoutCard";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/programs_/$programId")({
  component: ProgramDetailPage,
});

function ProgramDetailPage() {
  const { programId } = Route.useParams();
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();

  const { program } = useProgramById(programId);
  const { programs: allPrograms } = useAllProgramsWithWorkouts();

  const [isUpdating, setIsUpdating] = useState(false);

  // Editable title and description state
  const [editedName, setEditedName] = useState(program?.name ?? "");
  const [editedDescription, setEditedDescription] = useState(
    program?.description ?? "",
  );
  const [hasHeaderChanges, setHasHeaderChanges] = useState(false);
  const [isSavingHeader, setIsSavingHeader] = useState(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea based on content
  const adjustTextareaHeight = () => {
    const textarea = descriptionRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  };

  // Sync local state when program data loads or changes externally
  useEffect(() => {
    if (program && !hasHeaderChanges) {
      setEditedName(program.name);
      setEditedDescription(program.description ?? "");
    }
  }, [program?.name, program?.description, hasHeaderChanges]);

  // Adjust textarea height when description changes
  useEffect(() => {
    adjustTextareaHeight();
  }, [editedDescription]);

  const handleNameChange = (value: string) => {
    setEditedName(value);
    setHasHeaderChanges(
      value !== program?.name ||
        editedDescription !== (program?.description ?? ""),
    );
  };

  const handleDescriptionChange = (value: string) => {
    setEditedDescription(value);
    setHasHeaderChanges(
      editedName !== program?.name || value !== (program?.description ?? ""),
    );
  };

  const handleSaveHeader = async () => {
    if (!program || !editedName.trim()) return;
    setIsSavingHeader(true);
    try {
      programsCollection.update(program.id, (draft) => {
        draft.name = editedName.trim();
        draft.description = editedDescription.trim();
      });
      setHasHeaderChanges(false);
      toast("Program updated");
    } catch (error) {
      console.error("Failed to update program:", error);
      toast.error("Failed to update program");
    } finally {
      setIsSavingHeader(false);
    }
  };

  const handleSetActive = async () => {
    if (!program) return;
    setIsUpdating(true);
    try {
      // Optimistically deactivate all other programs first
      for (const p of allPrograms) {
        if (p.isActive && p.id !== program.id) {
          programsCollection.update(p.id, (draft) => {
            draft.isActive = false;
          });
        }
      }
      // Then activate this one
      programsCollection.update(program.id, (draft) => {
        draft.isActive = true;
      });
      toast("Program set as active");
    } catch (error) {
      console.error("Failed to set active program:", error);
      toast.error("Failed to set active program");
    } finally {
      setIsUpdating(false);
    }
  };

  if (!program) {
    return (
      <>
        <div className="page-container">
          <div className="px-4 pt-12 pb-24">
            <div className="text-center py-12">
              <h2 className="text-2xl font-bold mb-2">Program Not Found</h2>
              <p className="text-base-content/70 mb-4">
                The program you're looking for doesn't exist.
              </p>
              <Button
                variant="default"
                onClick={() => navigate({ to: "/programs" })}
              >
                Back to Programs
              </Button>
            </div>
          </div>
        </div>
        {isMobile && <TabBar currentPath={location.pathname} />}
      </>
    );
  }

  return (
    <>
      <div className="page-container">
        <div
          className={`px-4 pt-6 ${isMobile && !program.isActive ? "pb-28" : "pb-24"}`}
        >
          {/* Back Link */}
          <Link
            to="/programs"
            className="inline-flex items-center text-xs font-mono uppercase tracking-widest text-base-content/50 hover:text-base-content transition-colors mb-6"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Programs
          </Link>

          {/* Program Header */}
          <div className="mb-6 px-0">
            <div className="flex items-center gap-3 mb-1">
              <input
                type="text"
                value={editedName}
                onChange={(e) => handleNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && hasHeaderChanges) {
                    e.preventDefault();
                    handleSaveHeader();
                  }
                }}
                className="page-title bg-transparent border-none outline-none focus:ring-0 p-0 flex-1"
                placeholder="Program name"
              />
              {program.isActive && (
                <span className="badge-active shrink-0">Active</span>
              )}
              {!program.isActive && !isMobile && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSetActive}
                  disabled={isUpdating}
                  className="shrink-0"
                >
                  {isUpdating ? "Setting..." : "Set as Active"}
                </Button>
              )}
            </div>
            <textarea
              ref={descriptionRef}
              value={editedDescription}
              onChange={(e) => handleDescriptionChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && hasHeaderChanges) {
                  e.preventDefault();
                  handleSaveHeader();
                }
              }}
              className="text-base-content/70 bg-transparent border-none outline-none focus:ring-0 p-0 w-full resize-none overflow-hidden mt-2"
              placeholder="Add a description..."
              rows={1}
            />
            {hasHeaderChanges && (
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveHeader}
                disabled={isSavingHeader || !editedName.trim()}
                className="mt-2"
              >
                {isSavingHeader ? "Saving..." : "Save Changes"}
              </Button>
            )}
          </div>

          {/* Workouts */}
          <div className="space-y-6">
            {program.workouts.map((workout) => (
              <WorkoutCard key={workout.id} workout={workout} />
            ))}
          </div>
        </div>
      </div>

      {/* Mobile: Sticky bottom banner when not active */}
      {!program.isActive && isMobile && (
        <div className="fixed bottom-0 left-0 right-0 bg-base-100 border-t border-base-300 p-4 shadow-lg">
          <Button
            variant="primary"
            className="w-full"
            onClick={handleSetActive}
            disabled={isUpdating}
          >
            {isUpdating ? "Setting..." : "Set as Active Program"}
          </Button>
        </div>
      )}
    </>
  );
}
