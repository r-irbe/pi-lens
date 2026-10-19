defmodule Corpus.Counter do
  @moduledoc "A small GenServer with pattern matching and pipes."
  use GenServer

  def start_link(initial \\ 0), do: GenServer.start_link(__MODULE__, initial)

  @impl true
  def init(initial), do: {:ok, initial}

  @impl true
  def handle_call(:get, _from, count), do: {:reply, count, count}

  def handle_cast({:add, n}, count) when is_integer(n) do
    {:noreply, count + n}
  end

  def summarize(values) do
    values
    |> Enum.filter(&(&1 > 0))
    |> Enum.map(fn v -> v * 2 end)
    |> Enum.sum()
  end
end
