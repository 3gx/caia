/**
 * Shared Slack Block Kit types.
 * Used by both Claude and Codex providers.
 */

/**
 * Slack Block Kit block type.
 * Simplified for our use case - covers section, context, actions, divider, header, input.
 */
export interface Block {
  type: string;
  block_id?: string;
  text?: {
    type: string;
    text: string;
  };
  elements?: unknown[];
  accessory?: unknown;
  /** Slack expand property - prevents "See more" collapse on long sections */
  expand?: boolean;
}

/**
 * Input block type for modals (uses singular 'element' not 'elements').
 */
export interface InputBlock {
  type: 'input';
  block_id: string;
  element: {
    type: 'plain_text_input';
    action_id: string;
    placeholder?: { type: 'plain_text'; text: string };
    initial_value?: string;
    max_length?: number;
  };
  label: { type: 'plain_text'; text: string };
  hint?: { type: 'plain_text'; text: string };
}

/**
 * Union type for all block types used in modals.
 */
export type ModalBlock = Block | InputBlock;
