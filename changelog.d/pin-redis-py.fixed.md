Pinned redis-py to the 5.x line so fresh installs no longer pull redis-py 8.x, which broke all real-time WebSocket updates with a recurring "Timeout reading from redis" error on idle connections
