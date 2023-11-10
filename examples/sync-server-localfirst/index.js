import { LocalFirstAuthSyncServer } from "@automerge/automerge-repo-auth-localfirst-syncserver"

const DEFAULT_PORT = 3030
const port = Number(process.env.PORT) || DEFAULT_PORT
const host = process.env.HOST || "localhost"

const server = new LocalFirstAuthSyncServer(host)

server.listen({ port })
