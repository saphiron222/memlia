// Modified by Memlia in 2026. Upstream Apache-2.0 license and notices retained.
import { Body, Container, Head, Html, Img, Preview, Section } from '@react-email/components'
import { baseStyles } from '@/components/emails/_styles'
import { EmailFooter } from '@/components/emails/components/email-footer'
import { EMAIL_WORDMARK_SIZE } from '@/lib/branding/wordmark'
import { getBaseUrl } from '@/lib/core/utils/urls'
import { getBrandConfig } from '@/lib/branding'

/**
 * Sim's own wordmark: a committed raster export of the brand outlines in
 * `@/lib/branding/wordmark`, since email clients strip inline SVG. Both
 * dimensions are pinned because they do no responsive image selection either.
 */
const WORDMARK_SIZE = {
  width: String(EMAIL_WORDMARK_SIZE.width),
  height: String(EMAIL_WORDMARK_SIZE.height),
} as const

/**
 * Whitelabeled logos are arbitrary aspect ratios, so only height is pinned —
 * matched to the wordmark so both marks read at the same weight.
 */
const CUSTOM_LOGO_SIZE = { height: String(EMAIL_WORDMARK_SIZE.height) } as const

interface EmailLayoutProps {
  /** Preview text shown in email client list view */
  preview: string
  /** Email content to render inside the layout */
  children: React.ReactNode
  /** Optional: hide footer for internal emails */
  hideFooter?: boolean
  /**
   * Whether to show unsubscribe link in footer.
   * Set to false for transactional emails where unsubscribe doesn't apply.
   */
  showUnsubscribe: boolean
}

/**
 * Shared email layout wrapper providing consistent structure.
 * Includes Html, Head, Body, Container with logo header, and Footer.
 */
export function EmailLayout({
  preview,
  children,
  hideFooter = false,
  showUnsubscribe,
}: EmailLayoutProps) {
  const brand = getBrandConfig()
  const baseUrl = getBaseUrl()
  const hasCustomLogo = Boolean(brand.logoUrl)

  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={baseStyles.main}>
        <Container style={baseStyles.container}>
          <Section style={baseStyles.header}>
            <Img
              src={brand.logoUrl || `${baseUrl}/brand/color/email/wordmark.png`}
              alt={brand.name}
              {...(hasCustomLogo ? CUSTOM_LOGO_SIZE : WORDMARK_SIZE)}
              style={hasCustomLogo ? { display: 'block', width: 'auto' } : { display: 'block' }}
            />
          </Section>

          <Section style={baseStyles.content}>{children}</Section>
        </Container>

        {!hideFooter && <EmailFooter baseUrl={baseUrl} showUnsubscribe={showUnsubscribe} />}
      </Body>
    </Html>
  )
}

export default EmailLayout
