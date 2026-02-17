import { Component } from 'react';
import btn from '../../styles/buttons.module.css';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error(`[${this.props.name || 'Module'}] Error:`, error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          textAlign: 'center',
          padding: '80px 24px',
          color: '#7A8BA0',
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ color: '#0F1724', marginBottom: 8, fontFamily: 'var(--tc-font-heading)' }}>
            Something went wrong{this.props.name ? ` in ${this.props.name}` : ''}
          </h2>
          <p style={{ marginBottom: 20, fontSize: 14 }}>
            An unexpected error occurred. Try reloading the page.
          </p>
          <button
            className={btn.secondaryBtn}
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
          >
            Reload Page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
