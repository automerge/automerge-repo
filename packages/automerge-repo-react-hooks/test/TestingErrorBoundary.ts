import React from "react"

/**
 * This error boundary class should have behaviour equivalent to
 * React's built-in ErrorBoundary component.
 * It just doesn't pollute the test logs.
 */
interface Props {
  children: React.ReactNode
  fallback?: React.ReactNode
  onError?: (error: Error, info: React.ErrorInfo) => void
}

interface State {
  hasError: boolean
}

export class TestingErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.props.onError?.(error, info)
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || null
    }

    return this.props.children
  }
}
