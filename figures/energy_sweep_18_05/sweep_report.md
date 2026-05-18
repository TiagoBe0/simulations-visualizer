# Analisis del barrido energetico del PKA (18_05_corridas)

## Cobertura

- Corridas analizadas: 1
- Energias: [np.int64(10)] keV
- Niveles sp3 objetivo: [np.int64(20)] %
- Por frame: hibridacion, defectos, energias, desplazamientos (vs t0 y vs previo).
- Estructura (RDF/ADF/S(k)) en frame inicial, pico de dano y final.

## Resumen por corrida

| energy_kev | sp3_target | delta_sp3_percent | peak_n_displaced | final_n_displaced | recovery_fraction | max_defect_percent |
| --- | --- | --- | --- | --- | --- | --- |
| 10.000 | 20.000 | 0.254 | 32.000 | 11.000 | 0.656 | 0.003 |

## Escalamiento con la energia (ajustes por nivel sp3)

| sp3_target | metric | lin_slope_per_keV | lin_R2 | power_exponent | corr_pearson |
| --- | --- | --- | --- | --- | --- |
| 20 | peak_n_displaced | nan | nan | nan | nan |
| 20 | final_n_displaced | nan | nan | nan | nan |
| 20 | delta_sp3_percent | nan | nan | nan | nan |

## Patrones detectados

- sp3 20%: cascada pico ~ nan atomos/keV (R2=nan, exponente potencia=nan).
- Recuperacion media por sp3: 20%->0.66.
- Menor dano residual promedio: nivel sp3 20% (mayor tolerancia a la radiacion en este barrido).
- Correlacion energia vs cascada pico: r=nan.

## Archivos

- `master_summary.csv`, `scaling_statistics.csv`, `correlation_matrix.csv`
- Figuras de barrido en este directorio; por corrida en `E{e}_sp3_{c}/`.
