export const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export const WEEKDAY_ALIASES: Record<string, (typeof WEEKDAYS)[number]> = {
  sunday: "sunday",
  sun: "sunday",
  monday: "monday",
  mon: "monday",
  tuesday: "tuesday",
  tue: "tuesday",
  tues: "tuesday",
  wednesday: "wednesday",
  wed: "wednesday",
  thursday: "thursday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  friday: "friday",
  fri: "friday",
  saturday: "saturday",
  sat: "saturday",
};

export const WEEKDAY_TOKEN =
  "(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)";
