'use client'

// Modified by Memlia: use the fixed product identity in native Chat labels.

import { useEffect } from 'react'
import { useAnimatedPlaceholder } from '@/hooks/use-animated-placeholder'

interface AnimatedPlaceholderEffectProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  isInitialView: boolean
}

export function AnimatedPlaceholderEffect({
  textareaRef,
  isInitialView,
}: AnimatedPlaceholderEffectProps) {
  const animatedPlaceholder = useAnimatedPlaceholder(isInitialView)
  const placeholder = isInitialView ? animatedPlaceholder : 'Send message to Memlia'

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.placeholder = placeholder
    }
  }, [placeholder, textareaRef])

  return null
}
