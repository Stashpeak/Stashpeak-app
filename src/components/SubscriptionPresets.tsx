import { useMemo, useState } from "react";
import { CARD_SURFACE } from "../lib/surfaceStyles";
import { PRESETS, type Preset } from "../lib/subscriptionPresets";
import { CategorySelector } from "./CategorySelector";

interface SubscriptionPresetsProps {
  onPresetSelect: (preset: Preset) => void;
}

function presetLabel(preset: Preset): string {
  return `${preset.name} - ${preset.provider}`;
}

export function SubscriptionPresets({ onPresetSelect }: SubscriptionPresetsProps) {
  const [selectedLabel, setSelectedLabel] = useState("");

  const presetLabels = useMemo(() => PRESETS.map(presetLabel), []);
  const presetByLabel = useMemo(
    () => new Map(PRESETS.map((preset) => [presetLabel(preset), preset])),
    [],
  );

  function handleChange(value: string) {
    setSelectedLabel("");
    const preset = presetByLabel.get(value);
    if (preset) {
      onPresetSelect(preset);
    }
  }

  return (
    <div className={CARD_SURFACE}>
      <h3 className="text-base text-primary font-normal">
        Presets
      </h3>
      <p className="mt-1 text-sm text-secondary">
        Pick a service to pre-fill the form. Review and add your actual billing amount before saving.
      </p>

      <div className="mt-4">
        <CategorySelector
          value={selectedLabel}
          categories={presetLabels}
          onChange={handleChange}
          placeholder="Select a preset..."
          allowCreate={false}
          readonlyInput={true}
        />
      </div>
    </div>
  );
}
