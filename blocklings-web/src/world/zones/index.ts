/**
 * ZONES BARREL — imports every batch file (each registers its six builders
 * with the stream at import time) and re-runs the explicit hooks once for
 * belt-and-braces determinism. Imported by src/world/index.ts BEFORE the
 * ZoneStream is constructed, so all 90 builders are registered before the
 * first residency scan. Registration is last-write-wins and cheap, so the
 * double registration (import side effect + explicit call) is harmless.
 */
import { registerBatch1 } from './batch1'
import { registerBatch2 } from './batch2'
import { registerBatch3 } from './batch3'
import { registerBatch4 } from './batch4'
import { registerBatch5 } from './batch5'
import { registerBatch6 } from './batch6'
import { registerBatch7 } from './batch7'
import { registerBatch8 } from './batch8'
import { registerBatch9 } from './batch9'
import { registerBatch10 } from './batch10'
import { registerBatch11 } from './batch11'
import { registerBatch12 } from './batch12'
import { registerBatch13 } from './batch13'
import { registerBatch14 } from './batch14'
import { registerBatch15 } from './batch15'

/** Register all 90 zone builders (idempotent). */
export function registerAllZoneBatches(): void {
  registerBatch1()
  registerBatch2()
  registerBatch3()
  registerBatch4()
  registerBatch5()
  registerBatch6()
  registerBatch7()
  registerBatch8()
  registerBatch9()
  registerBatch10()
  registerBatch11()
  registerBatch12()
  registerBatch13()
  registerBatch14()
  registerBatch15()
}
