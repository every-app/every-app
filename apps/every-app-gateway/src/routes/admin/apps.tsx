import { createFileRoute } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { useState } from "react";
import { Plus } from "lucide-react";
import { adminAppsCollection } from "@/client/tanstack-db";
import { AppsTable } from "@/client/components/admin/AppsTable";
import { AddAppModal } from "@/client/components/admin/AddAppModal";
import { EditAppModal } from "@/client/components/admin/EditAppModal";
import { DeleteAppModal } from "@/client/components/admin/DeleteAppModal";
import { ManageAppAccessModal } from "@/client/components/admin/ManageAppAccessModal";
import type { AppWithAccessCount } from "@/types/app";

export const Route = createFileRoute("/admin/apps")({
  component: AppsPage,
});

function AppsPage() {
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showAccessModal, setShowAccessModal] = useState(false);
  const [selectedApp, setSelectedApp] = useState<AppWithAccessCount | null>(
    null,
  );

  const {
    data: apps,
    isError,
    isLoading,
  } = useLiveQuery((q) => q.from({ app: adminAppsCollection }));

  const handleEdit = (app: AppWithAccessCount) => {
    setSelectedApp(app);
    setShowEditModal(true);
  };

  const handleDelete = (app: AppWithAccessCount) => {
    setSelectedApp(app);
    setShowDeleteModal(true);
  };

  const handleManageAccess = (appId: string) => {
    const app = apps?.find((a) => a.id === appId);
    if (app) {
      setSelectedApp(app);
      setShowAccessModal(true);
    }
  };

  const confirmDelete = () => {
    if (selectedApp) {
      adminAppsCollection.delete(selectedApp.id);
      setShowDeleteModal(false);
      setSelectedApp(null);
    }
  };

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Apps</h1>
          <p className="text-base-content/70 mt-1">
            Manage the app catalog and user access
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setShowAddModal(true)}
        >
          <Plus className="w-4 h-4 mr-2" />
          Add App
        </button>
      </div>

      {isError && (
        <div className="alert alert-error">
          <span>Failed to load apps. Please try again.</span>
        </div>
      )}

      {isLoading && (
        <div className="flex justify-center py-12">
          <span className="loading loading-spinner loading-lg"></span>
        </div>
      )}

      {!isLoading && apps && (
        <AppsTable
          apps={apps}
          onManageAccess={handleManageAccess}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
      )}

      <AddAppModal open={showAddModal} onClose={() => setShowAddModal(false)} />

      <EditAppModal
        open={showEditModal}
        onClose={() => {
          setShowEditModal(false);
          setSelectedApp(null);
        }}
        app={selectedApp}
      />

      <DeleteAppModal
        open={showDeleteModal}
        onClose={() => {
          setShowDeleteModal(false);
          setSelectedApp(null);
        }}
        onConfirm={confirmDelete}
        app={selectedApp}
      />

      <ManageAppAccessModal
        open={showAccessModal}
        onClose={() => {
          setShowAccessModal(false);
          setSelectedApp(null);
        }}
        app={selectedApp}
      />
    </div>
  );
}
