"use client";

import { BlocksBoard } from "./BlocksBoard";
import { CarryExchange } from "./CarryExchange";
import { ChoiceList } from "./ChoiceList";
import { DecomposeDrag } from "./DecomposeDrag";
import { NumberLine } from "./NumberLine";
import { NumberPad } from "./NumberPad";
import type { InteractionProps } from "./types";

/**
 * 按 `item.interaction_type` 分发到具体交互组件（契约 §3 的六种取值全覆盖）。
 *
 * 未知类型退化成数字键盘：宁可让孩子用最朴素的方式把题做完，
 * 也不要因为前端没实现而卡住故事。
 */
export function InteractionRenderer(props: InteractionProps) {
  switch (props.item.interaction_type) {
    case "number_pad":
      return <NumberPad {...props} />;
    case "choice":
      return <ChoiceList {...props} />;
    case "blocks":
      return <BlocksBoard {...props} />;
    case "decompose_drag":
      return <DecomposeDrag {...props} />;
    case "carry_exchange":
      return <CarryExchange {...props} />;
    case "number_line":
      return <NumberLine {...props} />;
    default:
      return <NumberPad {...props} />;
  }
}

export { NumberPad, ChoiceList, BlocksBoard, DecomposeDrag, CarryExchange, NumberLine };
export type { InteractionProps, InteractionAnswer } from "./types";
