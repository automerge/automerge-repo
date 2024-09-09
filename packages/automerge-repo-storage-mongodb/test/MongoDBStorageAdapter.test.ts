import cp from "node:child_process"
import { beforeAll, describe } from "vitest"
import { MongoClient } from "mongodb"
import { runStorageAdapterTests } from "../../automerge-repo/src/helpers/tests/storage-adapter-tests"
import { MongoDBStorageAdapter } from "../src"

const MONGODB_URL = "mongodb://localhost:27017"
const MONGODB_DB_NAME = "automerge-repo-test-db"
const MONGODB_COLLECTION_NAME = "automerge-repo-storage"
const MONGODB_DOCKER_CONTAINER_NAME = "automerge-repo-test-mongo"

/**
 * @returns true if the docker cli is available
 */
function hasDocker() {
  try {
    cp.execFileSync("docker", ["--version"], { encoding: "utf8" })
    return true
  } catch {
    return false
  }
}

let client: MongoClient

describe.skipIf(!hasDocker())("MongoDBStorageAdapter", () => {
  beforeAll(async () => {
    try {
      cp.execFileSync("docker", ["kill", MONGODB_DOCKER_CONTAINER_NAME])
    } catch {
      // Will fail if no dockers are running
    }
    const mongoContainerId = cp
      .execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--detach",
          "--publish",
          "27017:27017",
          "--name",
          MONGODB_DOCKER_CONTAINER_NAME,
          "mongo",
        ],
        { encoding: "utf8" }
      )
      .trim()

    client = new MongoClient(MONGODB_URL)
    await client.connect()

    return async () => {
      cp.execFileSync("docker", ["kill", mongoContainerId])
    }
  })
  // TODO: Check if docker is available and skip tests if not
  const setup = async () => {
    const adapter = new MongoDBStorageAdapter(MONGODB_URL, {
      dbName: MONGODB_DB_NAME,
      collectionName: MONGODB_COLLECTION_NAME,
    })
    const teardown = async () => {
      await client.db(MONGODB_DB_NAME).dropCollection(MONGODB_COLLECTION_NAME)
    }
    return { adapter, teardown }
  }

  runStorageAdapterTests(setup)
})
