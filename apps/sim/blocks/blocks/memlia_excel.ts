// Copyright (c) 2026 Memlia. All rights reserved.
import { DocumentIcon } from '@/components/icons'
import type { BlockConfig } from '@/blocks/types'
import { IntegrationType } from '@/blocks/types'

export const MemliaExcelBlock: BlockConfig = {
  type: 'memlia_excel',
  name: 'Transformer un fichier Excel',
  description: 'Créer un nouveau fichier Excel à partir d’une procédure canonique.',
  longDescription:
    'Transforme les fichiers autorisés de l’espace de travail selon une procédure canonique et crée un nouveau fichier résultat, sans remplacer les sources. Nécessite un worker isolé configuré par l’opérateur et une image Excel admise. La sélection du bloc ne lance aucune exécution et ne confère aucune autorisation.',
  category: 'tools',
  integrationType: IntegrationType.Documents,
  bgColor: '#217346',
  icon: DocumentIcon,
  canvasPresentation: {
    defaultTitle: 'Transformer un fichier Excel',
    sentences: {
      default: [
        'Créer un fichier Excel',
        { text: 'avec la demande', field: 'request', core: true },
      ],
    },
  },
  subBlocks: [
    {
      id: 'request',
      title: 'Demande de transformation',
      type: 'code',
      language: 'json',
      required: true,
      placeholder: 'Demande canonique : procedure, sources et output',
      description:
        'Procédure canonique, sélections de fichiers de l’espace de travail et nouvelle sortie. Aucun chemin système, paramètre opérateur ou contexte d’exécution.',
    },
  ],
  tools: {
    access: ['memlia_excel_transform'],
    config: { tool: () => 'memlia_excel_transform' },
  },
  inputs: {
    request: { type: 'json', description: 'Demande canonique de transformation Excel.' },
  },
  outputs: {
    file: {
      type: 'file',
      description: 'Nouveau fichier résultat, publié après revalidation des droits et des sources.',
    },
  },
}
