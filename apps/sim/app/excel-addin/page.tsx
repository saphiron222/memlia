// Copyright (c) 2026 Memlia. All rights reserved.
import type { Metadata } from 'next'
import { ExcelTaskpane } from './taskpane'

export const metadata: Metadata = {
  title: 'Excel · Memlia',
  robots: { index: false, follow: false },
}

export default function ExcelAddinPage() {
  return <ExcelTaskpane />
}
