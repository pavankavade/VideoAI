"""
Windows-specific fixes for asyncio subprocess support.

This module provides utilities to run asyncio code properly on Windows,
especially when running in background threads.
"""

import asyncio
import sys
from typing import Coroutine, Any


def run_async_in_thread(coro: Coroutine) -> Any:
    """
    Run an async coroutine in a thread-safe way on Windows.
    
    This handles the NotImplementedError that occurs when trying to use
    asyncio.run() in a background thread on Windows.
    
    Args:
        coro: The async coroutine to run
        
    Returns:
        The result of the coroutine
    """
    # On Windows, we need to use the ProactorEventLoop for subprocess support
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    
    # Create a new event loop for this thread
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    
    try:
        return loop.run_until_complete(coro)
    finally:
        # Clean up
        try:
            # Cancel all remaining tasks
            pending = asyncio.all_tasks(loop)
            for task in pending:
                task.cancel()
            
            # Wait for tasks to finish cancelling
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            
            # Shutdown async generators
            loop.run_until_complete(loop.shutdown_asyncgens())
        except Exception:
            pass
        finally:
            loop.close()


class AsyncioThreadRunner:
    """
    Context manager for running asyncio code in threads on Windows.
    
    Usage:
        with AsyncioThreadRunner() as runner:
            result = runner.run(my_async_function())
    """
    
    def __init__(self):
        self.loop = None
        
    def __enter__(self):
        if sys.platform == 'win32':
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
        
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        return self
    
    def run(self, coro: Coroutine) -> Any:
        """Run a coroutine in the thread's event loop."""
        if self.loop is None:
            raise RuntimeError("AsyncioThreadRunner not properly initialized")
        return self.loop.run_until_complete(coro)
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.loop:
            try:
                # Cancel all remaining tasks
                pending = asyncio.all_tasks(self.loop)
                for task in pending:
                    task.cancel()
                
                # Wait for tasks to finish cancelling
                if pending:
                    self.loop.run_until_complete(
                        asyncio.gather(*pending, return_exceptions=True)
                    )
                
                # Shutdown async generators
                self.loop.run_until_complete(self.loop.shutdown_asyncgens())
            except Exception:
                pass
            finally:
                self.loop.close()
                self.loop = None
