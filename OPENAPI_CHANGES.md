# Changements OpenAPI à appliquer après déploiement

Les chemins et les `operationId` existants doivent rester inchangés.

## Paramètres de compactage

Pour les opérations Code, JORF et KALI concernées, documenter les paramètres optionnels suivants :

- `includeText` (`boolean`) : inclure ou exclure le texte intégral ;
- `limit` (`integer`) : nombre maximal d’éléments conservés ;
- `depth` (`integer`) : profondeur maximale des arborescences.

## Paramètres Judilibre multiples

Déclarer les paramètres acceptant plusieurs valeurs, notamment `chamber`, `solution` et `keys`, comme des tableaux sérialisés avec :

```yaml
style: form
explode: true
```

Le proxy accepte également une chaîne séparée par des virgules et la sérialise en paramètres répétés vers Judilibre.

## Dates Judilibre

- `date_start` et `date_end` : `type: string`, `format: date` ;
- `date_type` : valeur par défaut `decision` pour `/jd/scan` et `/jd/export` ;
- réponse `400` lorsque le format est invalide ou que `date_start` est postérieure à `date_end`.

## Métadonnées de réponse

Ajouter, lorsqu’elles sont présentes :

```yaml
meta:
  type: object
  properties:
    compacted: { type: boolean }
    truncated: { type: boolean }
    responseBytes: { type: integer }
    maxResponseBytes: { type: integer }
```

Documenter également :

- `fallback_used` pour les fallbacks article et ChronoLégi ;
- `applicable_date` et `version` pour le droit applicable à une date ;
- `semanticWarning` lorsqu’aucun article ne correspond strictement au numéro et au code ;
- `filterValidation` pour le contrôle local des résultats Judilibre (`requested`, `dateField`, `upstreamCount`, `returnedCount`, `filteredOut`).

## Variables de déploiement

Les variables facultatives suivantes peuvent être configurées sans être exposées dans le schéma public :

- `MAX_RESPONSE_BYTES` ;
- `DEFAULT_RESPONSE_LIMIT` ;
- `MAX_STRING_LENGTH`.
