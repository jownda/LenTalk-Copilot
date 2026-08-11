import { loadImageElement } from './imageData';
import type { MergeStoryboardImagesPayload, MergeStoryboardImagesResult } from '@/commands/image';

const PLACEHOLDER_RGBA = 'rgba(0,0,0,0.35)';
const BORDER_RGBA = 'rgba(255,255,255,0.22)';
const BADGE_BG_RGBA = 'rgba(0,0,0,0.65)';
const NOTE_OVERLAY_BG_RGBA = 'rgba(0,0,0,0.6)';

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function parseHexColor(value: string, fallback: string): string {
  const trimmed = value.trim();
  const hexMatch = /^#?([0-9a-fA-F]{3,8})$/.exec(trimmed);
  if (!hexMatch) {
    return fallback;
  }
  let hex = hexMatch[1];
  if (hex.length === 3) {
    hex = hex.split('').map((ch) => ch + ch).join('');
  } else if (hex.length === 4) {
    hex = hex.split('').map((ch) => ch + ch).join('');
  } else if (hex.length > 6) {
    hex = hex.slice(0, 6);
  }
  return `#${hex}`;
}

function trimTextToWidth(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  const safeText = text.trim();
  if (!safeText) {
    return '';
  }
  if (context.measureText(safeText).width <= maxWidth) {
    return safeText;
  }
  let content = safeText;
  while (content.length > 1) {
    content = content.slice(0, -1);
    const withEllipsis = `${content}...`;
    if (context.measureText(withEllipsis).width <= maxWidth) {
      return withEllipsis;
    }
  }
  return '...';
}

async function loadFrameImage(source: string): Promise<HTMLImageElement | null> {
  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return await loadImageElement(trimmed);
  } catch {
    return null;
  }
}

export async function localMergeStoryboardImages(
  payload: MergeStoryboardImagesPayload
): Promise<MergeStoryboardImagesResult> {
  const rows = Math.max(1, Math.floor(Number.isFinite(payload.rows) ? payload.rows : 1));
  const cols = Math.max(1, Math.floor(Number.isFinite(payload.cols) ? payload.cols : 1));
  const totalCells = rows * cols;
  const frameSources = Array.isArray(payload.frameSources) ? payload.frameSources : [];

  const loadedImages = await Promise.all(
    frameSources.slice(0, totalCells).map((source) => loadFrameImage(source))
  );

  const referenceImage = loadedImages.find((image): image is HTMLImageElement => Boolean(image));
  if (!referenceImage) {
    throw new Error('没有可导出的图片');
  }

  const referenceWidth = Math.max(1, referenceImage.naturalWidth || referenceImage.width || 1);
  const referenceHeight = Math.max(1, referenceImage.naturalHeight || referenceImage.height || 1);

  const rawGap = clampInteger(payload.cellGap, 0, 240, 0);
  const rawPadding = clampInteger(payload.outerPadding, 0, 360, 0);
  const rawNoteHeight = clampInteger(payload.noteHeight, 0, 360, 0);
  const rawFontSize = clampInteger(payload.fontSize, 10, 240, 24);
  const maxDimension = clampInteger(payload.maxDimension, 1024, 4096, 4096);

  const imageFit = payload.imageFit === 'contain' ? 'contain' : 'cover';
  const notePlacement = payload.notePlacement === 'bottom' ? 'bottom' : 'overlay';
  const showFrameIndex = Boolean(payload.showFrameIndex);
  const showFrameNote = Boolean(payload.showFrameNote);
  const overlayRequested = showFrameIndex || showFrameNote;
  const frameIndexPrefix = (payload.frameIndexPrefix ?? '').trim() || 'S';
  const textColor = parseHexColor(payload.textColor ?? '#f8fafc', '#f8fafc');
  const backgroundColor = parseHexColor(payload.backgroundColor, '#0f1115');

  const rawOutputWidth = rawPadding * 2 + cols * referenceWidth + (cols - 1) * rawGap;
  const rawOutputHeight =
    rawPadding * 2 +
    rows * (referenceHeight + rawNoteHeight) +
    Math.max(0, rows - 1) * rawGap;

  const longestSide = Math.max(rawOutputWidth, rawOutputHeight, 1);
  const scale = Math.min(maxDimension / longestSide, 1);

  const cellWidth = Math.max(8, Math.round(referenceWidth * scale));
  const cellHeight = Math.max(8, Math.round(referenceHeight * scale));
  const gap = Math.max(0, Math.round(rawGap * scale));
  const padding = Math.max(0, Math.round(rawPadding * scale));
  const noteHeight = Math.max(0, Math.round(rawNoteHeight * scale));
  const fontSize = Math.max(9, Math.round(rawFontSize * scale));

  const outputWidth = Math.max(
    1,
    padding * 2 + cols * cellWidth + Math.max(0, cols - 1) * gap
  );
  const outputHeight = Math.max(
    1,
    padding * 2 +
      rows * (cellHeight + noteHeight) +
      Math.max(0, rows - 1) * gap
  );

  const canvas = document.createElement('canvas');
  canvas.width = outputWidth;
  canvas.height = outputHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('导出画布初始化失败');
  }

  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, outputWidth, outputHeight);
  context.textBaseline = 'middle';
  context.textAlign = 'left';

  const frameNotes = Array.isArray(payload.frameNotes) ? payload.frameNotes : [];

  for (let index = 0; index < totalCells; index += 1) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const x = padding + col * (cellWidth + gap);
    const y = padding + row * (cellHeight + noteHeight + gap);

    context.fillStyle = PLACEHOLDER_RGBA;
    context.fillRect(x, y, cellWidth, cellHeight);

    const image = loadedImages[index];
    if (image) {
      const srcW = Math.max(1, image.naturalWidth || image.width || 1);
      const srcH = Math.max(1, image.naturalHeight || image.height || 1);
      const ratio = imageFit === 'contain'
        ? Math.min(cellWidth / srcW, cellHeight / srcH)
        : Math.max(cellWidth / srcW, cellHeight / srcH);
      const drawW = Math.max(1, Math.round(srcW * ratio));
      const drawH = Math.max(1, Math.round(srcH * ratio));
      const drawX = x + (cellWidth - drawW) / 2;
      const drawY = y + (cellHeight - drawH) / 2;
      context.drawImage(image, drawX, drawY, drawW, drawH);
    }

    if (col < cols - 1 && gap > 0) {
      context.fillStyle = BORDER_RGBA;
      context.fillRect(x + cellWidth, y, gap, cellHeight);
    }
    if (row < rows - 1 && gap > 0) {
      context.fillStyle = BORDER_RGBA;
      context.fillRect(x, y + cellHeight, cellWidth, gap);
    }

    if (overlayRequested) {
      context.font = `500 ${fontSize}px sans-serif`;
      if (showFrameIndex) {
        const label = `${frameIndexPrefix}${index + 1}`;
        const badgePaddingX = Math.max(6, Math.round(fontSize * 0.35));
        const badgeHeight = Math.max(18, Math.round(fontSize * 1.15));
        const textWidth = context.measureText(label).width;
        const badgeWidth = Math.round(textWidth + badgePaddingX * 2);
        const badgeX = x + 6;
        const badgeY = y + 6;

        context.fillStyle = BADGE_BG_RGBA;
        context.fillRect(badgeX, badgeY, badgeWidth, badgeHeight);
        context.fillStyle = textColor;
        context.fillText(label, badgeX + badgePaddingX, badgeY + badgeHeight / 2);
      }

      if (showFrameNote) {
        const note = trimTextToWidth(
          context,
          frameNotes[index] ?? '',
          Math.max(20, cellWidth - 14)
        );
        if (note) {
          if (notePlacement === 'bottom' && noteHeight > 0) {
            context.fillStyle = textColor;
            context.fillText(note, x + 4, y + cellHeight + noteHeight / 2);
          } else {
            const overlayHeight = Math.max(18, Math.round(fontSize * 1.35));
            const overlayY = y + cellHeight - overlayHeight;
            context.fillStyle = NOTE_OVERLAY_BG_RGBA;
            context.fillRect(x, overlayY, cellWidth, overlayHeight);
            context.fillStyle = textColor;
            context.fillText(note, x + 7, overlayY + overlayHeight / 2);
          }
        }
      }
    }
  }

  let imageUrl: string;
  try {
    imageUrl = canvas.toDataURL('image/png');
  } catch (error) {
    throw new Error(
      `画布导出失败：${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    imagePath: imageUrl,
    canvasWidth: outputWidth,
    canvasHeight: outputHeight,
    cellWidth,
    cellHeight,
    gap,
    padding,
    noteHeight,
    fontSize,
    textOverlayApplied: true,
  };
}