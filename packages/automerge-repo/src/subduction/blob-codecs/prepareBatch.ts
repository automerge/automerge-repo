import * as Automerge from "@automerge/automerge/slim"
import {
  BlobMeta,
  CommitId,
  CommitInput,
  Fragment,
  FragmentInput,
  LooseCommit,
  SedimentreeId,
} from "@automerge/automerge-subduction/slim"
import type { DocumentId } from "../../types.js"
import type { SubductionBlobCodec } from "./types.js"

export interface PreparedSubductionBatch {
  commitInputs: CommitInput[]
  fragmentInputs: FragmentInput[]
  acceptedHashes: string[]
  prepErrors: unknown[]
}

export async function prepareSubductionBatch<T>({
  doc,
  documentId,
  sedimentreeId,
  knownHashes,
  codec,
}: {
  doc: Automerge.Doc<T>
  documentId: DocumentId
  sedimentreeId: SedimentreeId
  knownHashes: Set<string>
  codec: SubductionBlobCodec
}): Promise<PreparedSubductionBatch> {
  const commitMetas = Automerge.getFragmentMetadata(doc, 0)
  const fragmentMetas = Automerge.getFragmentMetadata(doc, { start: 1 })

  const newCommitMetas = commitMetas.filter(m => !knownHashes.has(m.head))
  const newFragmentMetas = fragmentMetas.filter(m => !knownHashes.has(m.head))

  const newCommitBytes =
    newCommitMetas.length === 0
      ? []
      : Automerge.bundleFragmentMetadata(doc, newCommitMetas)
  const newFragmentBytes =
    newFragmentMetas.length === 0
      ? []
      : Automerge.bundleFragmentMetadata(doc, newFragmentMetas)

  const newCommits = newCommitMetas.map((m, i) => ({
    head: m.head,
    parents: m.boundary,
    bytes: newCommitBytes[i],
  }))
  const newFragments = newFragmentMetas.map((m, i) => ({
    head: m.head,
    boundary: m.boundary,
    checkpoints: m.checkpoints,
    bytes: newFragmentBytes[i],
  }))

  const acceptedHashes: string[] = []
  const commitInputs: CommitInput[] = []
  const fragmentInputs: FragmentInput[] = []
  const prepErrors: unknown[] = []

  for (const c of newCommits) {
    try {
      const commitBytes = await codec.encode(documentId, c.bytes)
      if (!commitBytes) {
        prepErrors.push(
          new Error(`blob codec returned null for commit ${c.head}`)
        )
        continue
      }
      const head = CommitId.fromHexString(c.head)
      const looseCommit = new LooseCommit(
        sedimentreeId,
        head,
        c.parents.map(p => CommitId.fromHexString(p)),
        new BlobMeta(commitBytes)
      )
      commitInputs.push(new CommitInput(looseCommit, commitBytes))
      acceptedHashes.push(c.head)
    } catch (e) {
      console.warn(
        `[SubductionSource] commit input prep failed for ${c.head}:`,
        e
      )
      prepErrors.push(e)
    }
  }

  for (const f of newFragments) {
    try {
      const fragmentBytes = await codec.encode(documentId, f.bytes)
      if (!fragmentBytes) {
        prepErrors.push(
          new Error(`blob codec returned null for fragment ${f.head}`)
        )
        continue
      }
      const head = CommitId.fromHexString(f.head)
      const boundary = f.boundary.map(b => CommitId.fromHexString(b))
      const checkpoints = f.checkpoints.map(c => CommitId.fromHexString(c))
      const fragment = new Fragment(
        sedimentreeId,
        head,
        boundary,
        checkpoints,
        new BlobMeta(fragmentBytes)
      )
      fragmentInputs.push(new FragmentInput(fragment, fragmentBytes))
      acceptedHashes.push(f.head)
    } catch (e) {
      console.warn(
        `[SubductionSource] fragment input prep failed for ${f.head}:`,
        e
      )
      prepErrors.push(e)
    }
  }

  return { commitInputs, fragmentInputs, acceptedHashes, prepErrors }
}
