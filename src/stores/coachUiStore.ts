import { create } from "zustand";

// Cross-view request to open a note straight on its Coaching tab (the
// calendar's "Prep" button navigates to the note, then the editor consumes it).
interface CoachUiState {
  pendingCoachNoteId: number | null;
  requestCoachTab: (noteId: number) => void;
  clearCoachTabRequest: () => void;
}

export const useCoachUiStore = create<CoachUiState>((set) => ({
  pendingCoachNoteId: null,
  requestCoachTab: (noteId) => set({ pendingCoachNoteId: noteId }),
  clearCoachTabRequest: () => set({ pendingCoachNoteId: null }),
}));
