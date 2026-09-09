import type { ForgeState } from '../shared/types.js';

export interface InterviewPhase {
  id: string;
  title: string;
  goal: string;
  question: string;
}

export const interviewPhases: InterviewPhase[] = [
  {
    id: 'purpose',
    title: 'Sistema e resultado',
    goal: 'Entender problema, usuários, resultado observável e fronteiras do sistema.',
    question: 'O que esse sistema faz, para quem ele existe e qual resultado concreto deve entregar? Diga também o que explicitamente não faz parte dele.'
  },
  {
    id: 'contexts',
    title: 'Contextos e atores',
    goal: 'Separar bounded contexts, agentes, humanos e sistemas externos.',
    question: 'Quais são os principais contextos do domínio e quem age em cada um deles: pessoas, Agents e sistemas externos?'
  },
  {
    id: 'entities',
    title: 'Entidades e identidade',
    goal: 'Descobrir entidades, propriedades, identidade semântica, características canônicas e relações que formam identidade contextual ou completam comportamento.',
    question: 'Quais entidades precisam existir? Para cada uma, o que a identifica semanticamente, quais propriedades são características canônicas e existe algum caso em que uma propriedade dela combinada com uma característica de outra Entity cria uma identidade única ou é necessária para completar seu comportamento?'
  },
  {
    id: 'types',
    title: 'Tipos semânticos',
    goal: 'Transformar propriedades primitivas em tipos semânticos e capacidades reutilizáveis.',
    question: 'Quais propriedades têm significado próprio e não deveriam ser apenas string/number/boolean? Cite restrições, unidades, formatos e capacidades como Comparable, Money, Identifier ou Timestamp.'
  },
  {
    id: 'intents',
    title: 'Intents',
    goal: 'Modelar objetivos imutáveis do sistema em vez de endpoints ou comandos de infraestrutura.',
    question: 'Quais objetivos os atores pedem ao sistema? Descreva cada Intent como resultado desejado, dados de entrada e condição de aceitação.'
  },
  {
    id: 'behaviors',
    title: 'AtomicAction Behaviors',
    goal: 'Decompor Intents em comportamentos atômicos reutilizáveis e Domain Actions instanciadas.',
    question: 'Para realizar esses Intents, quais comportamentos atômicos são necessários? Para cada um, diga entrada, saída, evento que ele ouve, invariantes e o que jamais pode acontecer.'
  },
  {
    id: 'governance',
    title: 'Invariantes e políticas',
    goal: 'Capturar regras que governam uso, autorização, consistência e self-healing.',
    question: 'Quais regras nunca podem ser violadas? Inclua autorização, isolamento, idempotência, consistência, limites e quando o fluxo deve entrar em self-healing ou Human-in-the-Healing-Loop.'
  },
  {
    id: 'flows',
    title: 'Fluxos e eventos',
    goal: 'Definir causalidade e orquestração sem transformar eventos de resultado em configuração livre.',
    question: 'Conte os fluxos principais em ordem causal: qual evento inicia cada fluxo, quais ações ocorrem em sequência ou paralelo e quais desvios de erro precisam existir?'
  },
  {
    id: 'capabilities',
    title: 'Capabilities e integrações',
    goal: 'Identificar recursos externos necessários sem acoplar a semântica ao fornecedor.',
    question: 'Quais capacidades externas são necessárias — banco, mensageria, pagamentos, arquivos, APIs, IA — e quais restrições de rede ou sandbox cada Action deve ter?'
  },
  {
    id: 'state',
    title: 'Estado, dados e recuperação',
    goal: 'Definir persistência, Event Sourcing, retomada, projeções e requisitos operacionais.',
    question: 'O que precisa sobreviver a reinícios? Quais estados, eventos ou snapshots devem ser persistidos, quais projeções são necessárias e quais requisitos de disponibilidade/latência importam?'
  },
  {
    id: 'review',
    title: 'Revisão',
    goal: 'Fechar lacunas antes de congelar o Blueprint.',
    question: 'Revise o modelo formado: há alguma entidade, relação de identidade, Intent, Action, regra, fluxo ou integração importante que ainda não apareceu ou algo que foi interpretado de forma errada?'
  }
];

export function phaseFor(state: ForgeState): InterviewPhase {
  return interviewPhases[Math.min(state.phaseIndex, interviewPhases.length - 1)]!;
}

export function nextQuestion(state: ForgeState, advanced: boolean): string {
  const index = Math.min(state.phaseIndex + (advanced ? 1 : 0), interviewPhases.length - 1);
  return interviewPhases[index]!.question;
}

export function progress(state: ForgeState): { current: number; total: number } {
  return { current: Math.min(state.phaseIndex + 1, interviewPhases.length), total: interviewPhases.length };
}
