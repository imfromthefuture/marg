import { Buffer } from 'buffer';

// @ton/core expects Node's Buffer; must load before any TON import.
(globalThis as any).Buffer = Buffer;
