"use client";

import React from "react";

export interface ActionChip {
  label: string;
  value: string;
  icon?: React.ReactNode;
}

interface ActionChipsProps {
  chips: ActionChip[];
  onSelect: (value: string) => void;
  disabled?: boolean;
}

export const ActionChips: React.FC<ActionChipsProps> = ({
  chips,
  onSelect,
  disabled = false,
}) => {
  if (!chips || chips.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {chips.map((chip, index) => (
        <button
          key={index}
          onClick={() => onSelect(chip.value)}
          disabled={disabled}
          className="group inline-flex items-center gap-1.5 px-3.5 py-2 bg-white border border-slate-200 rounded-full text-sm font-medium text-slate-700 hover:border-black hover:bg-black hover:text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm hover:shadow-md"
        >
          {chip.icon && <span className="text-slate-400 group-hover:text-white/80">{chip.icon}</span>}
          {chip.label}
        </button>
      ))}
    </div>
  );
};
