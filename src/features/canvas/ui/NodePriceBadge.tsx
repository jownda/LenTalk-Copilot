import { useRef, useState } from 'react';

type NodePriceBadgeProps = {
  label: string;
  title?: string;
  customPrice?: string | null;
  editable?: boolean;
  onPriceChange?: (value: string | null) => void;
};

export function NodePriceBadge({
  label,
  title,
  customPrice,
  editable = false,
  onPriceChange,
}: NodePriceBadgeProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftPrice, setDraftPrice] = useState('');
  const originalPriceRef = useRef<string | null>(null);
  const canEdit = editable && typeof onPriceChange === 'function';
  const resolvedLabel = label.trim() || '[无价格]';

  const startEditing = () => {
    if (!canEdit) return;
    originalPriceRef.current = customPrice?.trim() || null;
    const currentLabel = label.trim();
    setDraftPrice(customPrice?.trim() || (currentLabel === '[无价格]' ? '' : currentLabel));
    setIsEditing(true);
  };

  const finishEditing = () => {
    setIsEditing(false);
  };

  if (isEditing && canEdit) {
    return (
      <input
        autoFocus
        value={draftPrice}
        onChange={(event) => {
          const nextValue = event.target.value;
          setDraftPrice(nextValue);
          onPriceChange?.(nextValue.trim() || null);
        }}
        onBlur={finishEditing}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            finishEditing();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onPriceChange?.(originalPriceRef.current);
            finishEditing();
          }
        }}
        aria-label="价格"
        placeholder="输入价格"
        className="nodrag nowheel mr-2 h-6 w-[108px] min-w-0 rounded border border-accent/70 bg-bg-dark px-1.5 text-center text-[13px] leading-none text-text-dark outline-none"
      />
    );
  }

  return (
    <span
      title={canEdit ? '双击修改价格' : title}
      onDoubleClick={(event) => {
        event.stopPropagation();
        startEditing();
      }}
      className={`mr-2 shrink-0 text-[14px] leading-none font-normal text-[rgba(15,23,42,0.68)] dark:text-white/55 ${canEdit ? 'cursor-text select-none' : ''}`}
    >
      {resolvedLabel}
    </span>
  );
}
