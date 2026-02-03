/**
 * Shared Slack block builders.
 * Generic UI components used by both Claude and Codex providers.
 */

import type { Block } from './types.js';
import { MAX_BLOCK_TEXT_LENGTH } from './constants.js';

/**
 * Build blocks for path setup prompt when working directory not configured.
 * Identical across providers - shows the same setup instructions.
 */
export function buildPathSetupBlocks(): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':warning: *Working directory not configured*',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Before I can help, you need to set the working directory for this channel.\n\nThis is a *one-time setup* and cannot be changed later.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Steps:*\n1. `/ls` - explore current directory\n2. `/cd /path/to/project` - navigate to desired directory\n3. `/set-current-path` - lock the directory',
      },
    },
  ];
}

/**
 * Build blocks for error message display.
 */
export function buildErrorBlocks(message: string): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:x: *Error*\n${message}`,
      },
    },
  ];
}

/**
 * Build blocks for a text message, splitting into multiple blocks if needed.
 * Slack has a 3000 character limit per block text field.
 *
 * @param text - The text to display
 * @param maxBlockLength - Maximum characters per block (default 2900)
 * @returns Array of section blocks
 */
export function buildTextBlocks(text: string, maxBlockLength = MAX_BLOCK_TEXT_LENGTH): Block[] {
  const blocks: Block[] = [];

  if (text.length <= maxBlockLength) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
      expand: true,
    });
  } else {
    // Split at paragraph boundaries when possible
    let remaining = text;
    while (remaining.length > 0) {
      let chunk: string;
      if (remaining.length <= maxBlockLength) {
        chunk = remaining;
        remaining = '';
      } else {
        // Try to split at paragraph boundary
        let splitIndex = remaining.lastIndexOf('\n\n', maxBlockLength);
        if (splitIndex === -1 || splitIndex < maxBlockLength / 2) {
          // No good paragraph boundary, split at line boundary
          splitIndex = remaining.lastIndexOf('\n', maxBlockLength);
        }
        if (splitIndex === -1 || splitIndex < maxBlockLength / 2) {
          // No good line boundary, split at word boundary
          splitIndex = remaining.lastIndexOf(' ', maxBlockLength);
        }
        if (splitIndex === -1) {
          // No good boundary, hard split
          splitIndex = maxBlockLength;
        }

        chunk = remaining.slice(0, splitIndex);
        remaining = remaining.slice(splitIndex).trimStart();
      }

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: chunk,
        },
        expand: true,
      });
    }
  }

  return blocks;
}

/**
 * Build a context block with mrkdwn text.
 */
export function buildContextBlock(text: string): Block {
  return {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text,
      },
    ],
  };
}

/**
 * Build a divider block.
 */
export function buildDividerBlock(): Block {
  return { type: 'divider' };
}
