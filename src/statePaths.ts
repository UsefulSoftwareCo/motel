import * as os from "node:os"
import * as path from "node:path"
const stateHome = () => process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state")

/**
 * The shared, machine-global motel state directory. Holds the SQLite
 * database, daemon log, daemon lock, and the per-pid instance registry.
 * One motel daemon serves every project on this machine — there is no
 * per-cwd state.
 */
export const motelStateDir = () => process.env.MOTEL_RUNTIME_DIR?.trim() || path.join(stateHome(), "motel")
