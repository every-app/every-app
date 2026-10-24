import { SegmentedToggle } from "@/client/components/SegmentedToggle";
import { type ThemePreference, useThemePreference } from "@/client/lib/theme";

// Words, not icons: three glyphs in a menu said nothing.
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** System / Light / Dark segmented radio, for the account menu. */
export function ThemePreferenceRadio() {
  const { themePreference, setThemePreference } = useThemePreference();

  return (
    <SegmentedToggle
      items={THEME_OPTIONS}
      value={themePreference}
      onChange={setThemePreference}
      showLabels
      fullWidth
    />
  );
}
