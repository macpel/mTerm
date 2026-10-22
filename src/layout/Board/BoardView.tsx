//! Kanban board of one project, rendered in its center tab.

export function BoardView({ projectId, hidden }: { projectId: string; hidden: boolean }) {
  return <div className="board" data-project={projectId} style={{ display: hidden ? "none" : "flex" }} />;
}
