// Kinds of material schedules (#67); a module of its own so tests that mock the model still have them.
export const SCHEDULE_CATEGORIES = ["stal", "nadproza", "okna", "drzwi", "prefabrykaty", "inne"] as const;
export type ScheduleCategory = (typeof SCHEDULE_CATEGORIES)[number];
