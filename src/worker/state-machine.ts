export const createStateMachine = <State extends string, Context = any>(
  options: {
    initialState: State,
    transitions: Record<State, State[]>,
    context: Context,
    onExit: (state: State) => void
    onEnter: (state: State) => void
  }
) => {
  let currentState = options.initialState
  let context: Context = options.context

  return {
    getState: () => currentState,
    getContext: () => context,
    setContext: (newContext: Context) => { context = newContext},
    transitionTo: (newState: State, setContext?: (context: Context) => Context) => {
      const validTransitions = options.transitions[currentState]
      
      if (!validTransitions.includes(newState)) {
        throw new Error(`Invalid transition: ${currentState} -> ${newState}`)
      }

      if (setContext) context = setContext(context)
      options.onExit(currentState)
      currentState = newState
      options.onEnter(newState)
    }
  }
}
export type StateMachine = ReturnType<typeof createStateMachine>
