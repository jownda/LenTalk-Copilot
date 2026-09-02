import { describe, expect, it } from 'vitest';

import { parseAnnotationItems, stringifyAnnotationItems } from './codec';
import { drawAnnotations } from './draw';

describe('eraser annotations', () => {
  it('round-trips an eraser stroke without assigning a drawing color', () => {
    const serialized = stringifyAnnotationItems([
      {
        id: 'eraser-1',
        type: 'eraser',
        points: [12, 18, 30, 42],
        lineWidth: 16,
      },
    ]);

    expect(parseAnnotationItems(serialized)).toEqual([
      {
        id: 'eraser-1',
        type: 'eraser',
        points: [12, 18, 30, 42],
        lineWidth: 16,
      },
    ]);
  });

  it('draws an eraser stroke as opaque white', () => {
    const strokeColors: string[] = [];
    let strokeStyle = '';
    const context = {
      save: () => undefined,
      restore: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      stroke: () => strokeColors.push(strokeStyle),
      set strokeStyle(value: string) {
        strokeStyle = value;
      },
      set lineWidth(_value: number) {},
      set lineJoin(_value: CanvasLineJoin) {},
      set lineCap(_value: CanvasLineCap) {},
    } as unknown as CanvasRenderingContext2D;

    drawAnnotations(context, [
      {
        id: 'eraser-1',
        type: 'eraser',
        points: [12, 18, 30, 42],
        lineWidth: 16,
      },
    ]);

    expect(strokeColors).toEqual(['#ffffff']);
  });
});
