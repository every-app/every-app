import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";

/**
 * A select over a fixed list of string choices, outside a TanStack form
 * (useAppForm's SelectField is the one inside): the trigger shows the
 * chosen item's label, and `onValueChange` only ever gets one of `items`.
 */
export function ChoiceSelect<T extends string>({
  id,
  value,
  items,
  onValueChange,
  label,
  describedBy,
  size = "default",
  className = "w-full",
  disabled = false,
}: {
  id?: string;
  value: T;
  items: readonly { value: T; label: string }[];
  onValueChange: (value: T) => void;
  /** The accessible name, when no `<label for>` names the trigger. */
  label?: string;
  describedBy?: string;
  size?: "sm" | "default";
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        const found = items.find((item) => item.value === next);
        if (found) onValueChange(found.value);
      }}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        size={size}
        className={className}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
