// The ⌘K search palette: opened by ⌘K anywhere or the sidebar's search field.

import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { SearchPalette } from "@every-app/desktop-ui";
import { tabFor } from "./search";
import { useMeetingSearch, useSettled } from "./useSearch";

export const PALETTE_LIMIT = 8;

export function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const settled = useSettled(text);
  const { results } = useMeetingSearch(settled, PALETTE_LIMIT);
  const close = () => onOpenChange(false);
  return (
    <SearchPalette
      open={open}
      onOpenChange={onOpenChange}
      query={text}
      onQueryChange={setText}
      results={results}
      onOpen={(result) => {
        close();
        const tab = tabFor(result.field);
        void navigate({ to: "/meetings/$id", params: { id: result.meeting.id }, search: tab ? { tab } : {} });
      }}
      onShowAll={() => {
        close();
        void navigate({ to: "/search", search: settled ? { q: settled } : {} });
      }}
    />
  );
}
