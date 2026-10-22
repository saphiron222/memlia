// Copyright (c) 2026 Memlia. All rights reserved.
// TaskPaneApp structure reused from the accepted Microsoft-sample lab manifest.
const ADDIN_ID = 'b8f15665-1cc3-4a4d-8eba-7d54f3b44bc8'
function attribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** Configured product origin only. Host headers, query parameters and user identity are not inputs. */
export function createOfficeAddinManifest(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('office_manifest_url_refused')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('office_manifest_url_refused')
  }
  const origin = attribute(url.origin)
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="TaskPaneApp">
  <Id>${ADDIN_ID}</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>Memlia</ProviderName>
  <DefaultLocale>fr-FR</DefaultLocale>
  <DisplayName DefaultValue="Memlia"/>
  <Description DefaultValue="Sauvegarde privée du classeur dans votre instance Memlia."/>
  <IconUrl DefaultValue="${origin}/favicon/favicon-32x32.png"/>
  <HighResolutionIconUrl DefaultValue="${origin}/favicon/favicon-96x96.png"/>
  <SupportUrl DefaultValue="${origin}/excel-addin"/>
  <AppDomains><AppDomain>${origin}</AppDomain></AppDomains>
  <Hosts><Host Name="Workbook"/></Hosts>
  <Requirements><Sets DefaultMinVersion="1.1">
    <Set Name="File" MinVersion="1.1"/>
    <Set Name="CompressedFile" MinVersion="1.1"/>
  </Sets></Requirements>
  <DefaultSettings><SourceLocation DefaultValue="${origin}/excel-addin"/></DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
</OfficeApp>
`
}
