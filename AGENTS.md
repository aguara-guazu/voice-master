# AGENTS.md — instrucciones del workspace

Este archivo es la fuente de verdad del workspace. Cualquier agente que trabaje acá lo lee
primero y vuelve a él ante cualquier duda de proceso.

## Orden de lectura al iniciar sesión

1. `AGENTS.md` (este archivo) — reglas y proceso.
2. `notes.md` — estado real del proyecto: avances, decisiones, cambios en la base de código.
3. `to-myself.md` — nota personal entre sesiones. Leerla siempre, actualizarla cuando corresponda.
4. `findings/` — investigaciones previas. Consultar antes de reinvestigar algo.

## Estado del proyecto

Definición funcional del proyecto: **pendiente**. No asumir alcance, dominio ni stack: se
define con el usuario y se registra en `notes.md`.

Fase actual: **investigación y evaluación de viabilidad**. Todavía no se codea.

El proyecto no está atado a un solo lenguaje ni a un solo stack. La elección de tecnología es
una conclusión de la investigación, no un supuesto de partida.

## Proceso

1. **Investigar** — relevar opciones, restricciones técnicas, límites, costos, licencias.
2. **Evaluar viabilidad** — comparar alternativas con criterios explícitos y tradeoffs.
3. **Decidir** — dejar la decisión y su justificación en `notes.md`.
4. **Codear** — recién cuando hay una decisión registrada.

No saltar de la pregunta al código. Si falta información para decidir, preguntar.

## `findings/`

Todo lo que se encuentra durante la investigación se escribe acá. Un archivo por tema.

- Nombre: `AAAA-MM-DD-tema-en-kebab-case.md`.
- Contenido: qué se investigó, qué se encontró, qué se descartó y por qué, qué queda abierto.
- **Toda afirmación factual sobre el mundo externo va con enlace a la fuente** (precios,
  límites de servicios, comportamiento de herramientas, benchmarks, normativa). Si no hay
  fuente verificable, se dice explícitamente en lugar de afirmar.
- Distinguir siempre: dato verificado con fuente / prueba hecha localmente / hipótesis.
- Los findings no se reescriben para "quedar bien". Si algo se demostró falso, se corrige
  dejando registro de la corrección.

## `notes.md`

Referencia de entrada que segundea a este archivo. Se actualiza **activamente durante la
sesión y entre sesiones**.

Va: tareas encaradas, implementaciones, cambios hechos en la base de código, decisiones
tomadas, problemas abiertos y próximo paso. Entradas fechadas, de lo más reciente a lo más
viejo. Concreto y verificable, sin claims.

## `to-myself.md`

Nota personal del agente entre sesiones. Se lee al empezar y se actualiza a medida que el
proyecto avanza.

Contiene frases motivacionales cortas y notas breves de cómo viene el trabajo. Su función es
recordar que, independientemente del estado de ánimo o de lo trabado que esté el problema, se
avanza en positivo: **keep on keeping on 👍**.

## Reglas de trabajo

- **Idioma**: español neutro en documentación y comunicación. Sin voseo ni calcos del inglés.
  Los identificadores del código van en inglés.
- **Sin claims**: nunca escribir "listo para producción", "resuelto", "N veces más rápido" ni
  equivalentes sin evidencia concreta. Reportar lo que efectivamente se probó y cómo.
- **Comentarios en código**: solo guía técnica útil para modificar o debuggear. Nada de
  comentarios que describan lo obvio ni que narren cambios ("ahora arregla X").
- **Comillas**: simples en Python, dobles en JavaScript/TypeScript.
- **Tests**: no se escriben tests salvo pedido explícito del usuario.
- **`.env`**: no se modifica nunca. Si hace falta una variable, se le avisa al usuario.
- **Secretos**: no se piden, no se reproducen y no se escriben en código, notas ni findings.
  Se referencian por nombre desde un gestor de secretos.
- **Documentación**: los únicos markdown del workspace son `AGENTS.md`, `CLAUDE.md`,
  `notes.md`, `to-myself.md` y los de `findings/`. No se generan informes, guías de uso ni
  resúmenes adicionales.
- **Preguntar antes de asumir**: si faltan objetivo, alcance o restricciones, o si hay más de
  una interpretación razonable que cambiaría el trabajo, preguntar antes de desarrollar.
- **Señalar los problemas**: si un plan tiene una falla seria, decirlo directo y ofrecer
  alternativa con tradeoffs explícitos.
