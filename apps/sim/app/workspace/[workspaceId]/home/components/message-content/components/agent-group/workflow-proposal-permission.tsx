// Copyright (c) 2026 Memlia. All rights reserved.
'use client'

import { useEffect, useRef, useState } from 'react'
import { Chip } from '@sim/emcn'
import type { z } from 'zod'
import { requestJson, requestRaw } from '@/lib/api/client/request'
import {
  copilotToolPermissionContract,
  copilotWorkflowProposalReviewContract,
  workflowProposalReviewSchema,
} from '@/lib/api/contracts/copilot'

type Review = z.infer<typeof workflowProposalReviewSchema>
type Phase = 'loading' | 'ready' | 'submitting' | 'expired' | 'error' | 'allow' | 'skip'

/** Never enters the ordinary bulk/remembered-permission store. */
export function WorkflowProposalPermission({ toolCallId }: { toolCallId: string }) {
  const [review, setReview] = useState<Review | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const alive = useRef(false)
  const submitted = useRef(false)
  useEffect(() => {
    let current = true
    alive.current = true
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await requestRaw(
          copilotWorkflowProposalReviewContract,
          { query: { toolCallId }, signal: controller.signal },
          { cache: 'no-store' }
        )
        const owned = workflowProposalReviewSchema.parse(await response.json())
        if (!current) return
        if (owned.toolCallId !== toolCallId) throw new Error('proposal_unavailable')
        setReview(owned)
        setPhase(Date.now() >= Date.parse(owned.expiresAt) ? 'expired' : 'ready')
      } catch {
        if (current) setPhase('error')
      }
    })()
    return () => {
      current = false
      alive.current = false
      controller.abort()
    }
  }, [toolCallId])
  useEffect(() => {
    if (!review || phase !== 'ready') return
    const timer = setTimeout(
      () => setPhase('expired'),
      Math.max(0, Date.parse(review.expiresAt) - Date.now())
    )
    return () => clearTimeout(timer)
  }, [review, phase])

  async function decide(decision: 'allow' | 'skip') {
    if (!review || phase !== 'ready' || submitted.current) return
    if (Date.now() >= Date.parse(review.expiresAt)) {
      setPhase('expired')
      return
    }
    // Only the digest paired with the exact displayed response is sent.
    const expectedDigest = review.digest
    submitted.current = true
    setPhase('submitting')
    try {
      const response = await requestJson(copilotToolPermissionContract, {
        body: { decisions: [{ toolCallId, decision, expectedDigest }] },
      })
      if (!alive.current) return
      const result = response.results.length === 1 ? response.results[0] : undefined
      if (
        !result ||
        result.toolCallId !== toolCallId ||
        (result.decision !== 'allow' && result.decision !== 'skip')
      )
        throw new Error('proposal_unavailable')
      setPhase(result.decision)
    } catch {
      // Delivery can be unknown. Do not retry or claim cancellation/application.
      if (alive.current) setPhase('error')
    }
  }

  const messages: Record<Phase, string> = {
    loading: 'Chargement de la proposition…',
    ready: 'Vérifiez les opérations exactes avant de décider.',
    submitting: 'Enregistrement de la décision…',
    expired: 'Proposition expirée. Une nouvelle proposition est nécessaire.',
    error: 'Décision indisponible. Son état doit être vérifié auprès du serveur.',
    allow: 'Autorisation enregistrée. L’application reste soumise aux contrôles serveur.',
    skip: 'Refus enregistré.',
  }
  return (
    <section
      aria-label='Proposition de modification du workflow'
      className='flex min-w-0 flex-col gap-2 text-sm'
    >
      {review && (
        <>
          <dl className='break-all'>
            <dt>Workflow</dt>
            <dd>{review.workflowId}</dd>
            <dt>Espace</dt>
            <dd>{review.workspaceId}</dd>
            <dt>Révision :</dt>
            <dd> {review.expectedRevision}</dd>
            <dt>Émise le</dt>
            <dd>{review.issuedAt}</dd>
            <dt>Expire le</dt>
            <dd>{review.expiresAt}</dd>
            <dt>Digest</dt>
            <dd>{review.digest}</dd>
          </dl>
          <pre
            aria-label='Corps v2 exact'
            className='max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-xs'
          >
            {review.body}
          </pre>
        </>
      )}
      <p role='status' aria-live='polite'>
        {messages[phase]}
      </p>
      <div className='flex flex-wrap gap-1'>
        <Chip variant='primary' disabled={phase !== 'ready'} onClick={() => void decide('allow')}>
          Autoriser une fois
        </Chip>
        <Chip disabled={phase !== 'ready'} onClick={() => void decide('skip')}>
          Refuser
        </Chip>
      </div>
    </section>
  )
}
