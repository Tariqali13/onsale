import { Link } from 'react-router';

export function NotFound() {
  return (
    <div className="center-msg">
      <div>
        <h1>Wrong door</h1>
        <p>There’s nothing at this address.</p>
        <p style={{ marginTop: 16 }}>
          <Link to="/">Go to the event</Link>
        </p>
      </div>
    </div>
  );
}
