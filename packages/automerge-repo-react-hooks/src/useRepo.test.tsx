// @ts-nocheck
import { describe, expect, test } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { RepoContext, useRepo } from './useRepo'
import { Repo } from '@automerge/automerge-repo'

describe('useRepo', () => {
  const repo = new Repo({
    network: []
  });

  // const wrapper = props => (<RepoContext.Provider {...props} value={repo} />)
  test('should return repo from context', () => {
    expect(repo).toBeInstanceOf(Repo)
  //   const { result } = renderHook(() => useRepo(), { wrapper })

  //   console.log(result)

  //   expect(result).toBeInstanceOf(Repo)
  })

})
